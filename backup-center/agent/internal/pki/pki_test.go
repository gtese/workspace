package pki

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestGenerateKeyAndCSR(t *testing.T) {
	key, err := GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	if key.Curve != elliptic.P256() {
		t.Fatalf("期望 P-256，实际 %v", key.Curve)
	}
	csrPEM, err := CreateCSR(key, "eda131.tri.local")
	if err != nil {
		t.Fatalf("CreateCSR: %v", err)
	}
	csr, err := ParseCSR(csrPEM)
	if err != nil {
		t.Fatalf("ParseCSR: %v", err)
	}
	if csr.Subject.CommonName != "eda131.tri.local" {
		t.Fatalf("CN 不符: %s", csr.Subject.CommonName)
	}
	pub, ok := csr.PublicKey.(*ecdsa.PublicKey)
	if !ok || !pub.Equal(&key.PublicKey) {
		t.Fatal("CSR 公钥与私钥不匹配")
	}
}

func TestCreateCSRRejectsEmptyCN(t *testing.T) {
	key, err := GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := CreateCSR(key, ""); err == nil {
		t.Fatal("空 CN 应该失败")
	}
}

func TestParseCSRRejectsGarbage(t *testing.T) {
	if _, err := ParseCSR([]byte("not-a-csr")); err == nil {
		t.Fatal("非法 PEM 应该失败")
	}
}

func TestCertificateMatchesKey(t *testing.T) {
	key, err := GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	keyPEM, err := EncodeKeyPEM(key)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := selfSignedCert(t, key, "c_0123456789ab")
	if err := VerifyCertificateMatchesKey(certPEM, keyPEM); err != nil {
		t.Fatalf("证书与私钥应匹配: %v", err)
	}
	expiry, err := CertificateExpiry(certPEM)
	if err != nil || expiry.Before(time.Now()) {
		t.Fatalf("证书有效期异常: %v %v", expiry, err)
	}
	fp, err := Fingerprint(certPEM)
	if err != nil || len(fp) != 64 {
		t.Fatalf("指纹异常: %q %v", fp, err)
	}

	other, _ := GenerateKey()
	otherPEM, _ := EncodeKeyPEM(other)
	if err := VerifyCertificateMatchesKey(certPEM, otherPEM); err == nil {
		t.Fatal("不同私钥应校验失败")
	}
}

func TestWriteFile0600(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sub", "secret")
	if err := WriteFile0600(path, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("权限应为 0600，实际 %04o", perm)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != "hello" {
		t.Fatalf("内容不符: %q", raw)
	}
}

func selfSignedCert(t *testing.T, key *ecdsa.PrivateKey, cn string) []byte {
	t.Helper()
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(42),
		Subject:      pkix.Name{CommonName: cn},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}
