// Package pki 负责 EC P-256 私钥、CSR 与证书落盘。
package pki

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"time"

	"tri.local/backup-center/agent/internal/config"
)

// GenerateKey 生成 EC P-256 私钥。
func GenerateKey() (*ecdsa.PrivateKey, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("生成 EC P-256 私钥失败: %w", err)
	}
	return key, nil
}

// EncodeKeyPEM 将私钥编码为 SEC1 PEM。
func EncodeKeyPEM(key *ecdsa.PrivateKey) ([]byte, error) {
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, fmt.Errorf("编码私钥失败: %w", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), nil
}

// DecodeKeyPEM 解析 EC 私钥 PEM。
func DecodeKeyPEM(data []byte) (*ecdsa.PrivateKey, error) {
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, errors.New("私钥 PEM 解析失败")
	}
	switch block.Type {
	case "EC PRIVATE KEY":
		key, err := x509.ParseECPrivateKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("解析 EC 私钥失败: %w", err)
		}
		return key, nil
	case "PRIVATE KEY":
		keyAny, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("解析 PKCS#8 私钥失败: %w", err)
		}
		key, ok := keyAny.(*ecdsa.PrivateKey)
		if !ok {
			return nil, errors.New("私钥不是 EC 类型")
		}
		return key, nil
	default:
		return nil, fmt.Errorf("不支持的私钥 PEM 类型: %s", block.Type)
	}
}

// CreateCSR 生成 PKCS#10 CSR PEM（CN 为 commonName）。
func CreateCSR(key *ecdsa.PrivateKey, commonName string) ([]byte, error) {
	if key == nil {
		return nil, errors.New("私钥为空")
	}
	if commonName == "" {
		return nil, errors.New("CSR CommonName 不能为空")
	}
	tmpl := &x509.CertificateRequest{
		Subject: pkix.Name{
			CommonName:   commonName,
			Organization: []string{"backup-center"},
		},
		SignatureAlgorithm: x509.ECDSAWithSHA256,
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, tmpl, key)
	if err != nil {
		return nil, fmt.Errorf("生成 CSR 失败: %w", err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der}), nil
}

// ParseCSR 解析并自校验 CSR（签名必须有效、公钥必须为 EC P-256）。
func ParseCSR(data []byte) (*x509.CertificateRequest, error) {
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "CERTIFICATE REQUEST" {
		return nil, errors.New("CSR PEM 解析失败")
	}
	csr, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("解析 CSR 失败: %w", err)
	}
	if err := csr.CheckSignature(); err != nil {
		return nil, fmt.Errorf("CSR 签名校验失败: %w", err)
	}
	key, ok := csr.PublicKey.(*ecdsa.PublicKey)
	if !ok || key.Curve != elliptic.P256() {
		return nil, errors.New("CSR 公钥不是 EC P-256")
	}
	return csr, nil
}

// ParseCertificatePEM 解析第一张证书。
func ParseCertificatePEM(data []byte) (*x509.Certificate, error) {
	block, _ := pem.Decode(data)
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, errors.New("证书 PEM 解析失败")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("解析证书失败: %w", err)
	}
	return cert, nil
}

// CertificateExpiry 返回证书 NotAfter。
func CertificateExpiry(certPEM []byte) (time.Time, error) {
	cert, err := ParseCertificatePEM(certPEM)
	if err != nil {
		return time.Time{}, err
	}
	return cert.NotAfter, nil
}

// VerifyCertificateMatchesKey 校验证书公钥与私钥匹配。
func VerifyCertificateMatchesKey(certPEM, keyPEM []byte) error {
	cert, err := ParseCertificatePEM(certPEM)
	if err != nil {
		return err
	}
	key, err := DecodeKeyPEM(keyPEM)
	if err != nil {
		return err
	}
	pub, ok := cert.PublicKey.(*ecdsa.PublicKey)
	if !ok {
		return errors.New("证书公钥不是 EC 类型")
	}
	if !pub.Equal(&key.PublicKey) {
		return errors.New("证书与私钥不匹配")
	}
	return nil
}

// Fingerprint 返回证书 SHA-256 指纹（小写十六进制）。
func Fingerprint(certPEM []byte) (string, error) {
	cert, err := ParseCertificatePEM(certPEM)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(cert.Raw)
	return hex.EncodeToString(sum[:]), nil
}

// WriteFile0600 原子写入 0600 文件。
func WriteFile0600(path string, data []byte) error {
	return config.WriteFileAtomic(path, data, 0o600)
}

// ReadFile 读取文件（辅助函数，便于统一错误信息）。
func ReadFile(path string) ([]byte, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取 %s 失败: %w", path, err)
	}
	return raw, nil
}
