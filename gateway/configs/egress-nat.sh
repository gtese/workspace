#!/bin/sh
# ECS：出口隧道 NAT（OpenVPN 客户端 tun-egress）
set -e
sysctl -w net.ipv4.ip_forward=1 >/dev/null
iptables -C FORWARD -i tun-egress -j ACCEPT 2>/dev/null || iptables -A FORWARD -i tun-egress -j ACCEPT
iptables -C FORWARD -o tun-egress -j ACCEPT 2>/dev/null || iptables -A FORWARD -o tun-egress -j ACCEPT
iptables -t nat -C POSTROUTING -s 10.99.99.0/24 -o eth0 -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -s 10.99.99.0/24 -o eth0 -j MASQUERADE
iptables -t mangle -C FORWARD -i tun-egress -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss 1360 2>/dev/null || iptables -t mangle -A FORWARD -i tun-egress -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss 1360
exit 0
