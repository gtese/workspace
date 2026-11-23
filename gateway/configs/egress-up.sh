#!/bin/sh
# 253：出口隧道建立后恢复策略路由与标记（由 openvpn up 钩子/egress-routing.service 调用）
for i in $(seq 1 30); do
  ip link show tun-egress >/dev/null 2>&1 && break
  sleep 1
done
ip route replace default dev tun-egress table 100
ip rule add fwmark 100 table 100 priority 1001 2>/dev/null || true
ip rule add from 10.10.10.0/24 table 100 priority 1000 2>/dev/null || true
ip rule add from 10.10.10.0/24 to 172.16.0.0/16 lookup main priority 900 2>/dev/null || true
ip rule add from 10.10.10.0/24 to 10.10.10.0/24 lookup main priority 901 2>/dev/null || true
ip rule add from 10.10.10.0/24 to 192.168.9.0/24 lookup main priority 902 2>/dev/null || true
# dnsmasq/dante 出站打 mark（uid 以实际为准）
iptables -t mangle -C OUTPUT -m owner --uid-owner dnsmasq -j MARK --set-mark 100 2>/dev/null || iptables -t mangle -A OUTPUT -m owner --uid-owner dnsmasq -j MARK --set-mark 100
iptables -t mangle -C OUTPUT -m owner --uid-owner dante -j MARK --set-mark 100 2>/dev/null || iptables -t mangle -A OUTPUT -m owner --uid-owner dante -j MARK --set-mark 100
# 内网目标不走隧道
iptables -t mangle -C OUTPUT -m owner --uid-owner dnsmasq -d 172.16.0.0/16 -j RETURN 2>/dev/null || iptables -t mangle -I OUTPUT 1 -m owner --uid-owner dnsmasq -d 172.16.0.0/16 -j RETURN
iptables -t mangle -C OUTPUT -m owner --uid-owner dnsmasq -d 10.10.10.0/24 -j RETURN 2>/dev/null || iptables -t mangle -I OUTPUT 1 -m owner --uid-owner dnsmasq -d 10.10.10.0/24 -j RETURN
# 出隧道 SNAT
iptables -t nat -C POSTROUTING -o tun-egress -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -o tun-egress -j MASQUERADE
exit 0
