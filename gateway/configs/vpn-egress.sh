#!/bin/sh
# VPN 出口：OpenVPN 网段 10.66.66.0/24 经 eth0 出网
# 部署路径：/usr/local/sbin/vpn-egress.sh
# 由 vpn-egress.service 在启动时执行（幂等）
set -e

sysctl -w net.ipv4.ip_forward=1 >/dev/null

iptables -C FORWARD -i tun+ -o eth0 -j ACCEPT 2>/dev/null \
  || iptables -A FORWARD -i tun+ -o eth0 -j ACCEPT
iptables -C FORWARD -i eth0 -o tun+ -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null \
  || iptables -A FORWARD -i eth0 -o tun+ -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT

iptables -t nat -C POSTROUTING -s 10.66.66.0/24 -o eth0 -j MASQUERADE 2>/dev/null \
  || iptables -t nat -A POSTROUTING -s 10.66.66.0/24 -o eth0 -j MASQUERADE

# TCP MSS 钳制，避免隧道 MTU 导致的分片/黑洞
iptables -t mangle -C FORWARD -i tun+ -o eth0 -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss 1360 2>/dev/null \
  || iptables -t mangle -A FORWARD -i tun+ -o eth0 -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss 1360
iptables -t mangle -C FORWARD -i eth0 -o tun+ -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss 1360 2>/dev/null \
  || iptables -t mangle -A FORWARD -i eth0 -o tun+ -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss 1360
