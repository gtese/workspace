#!/usr/bin/env python3
"""校验 realm 模板：去掉 // 注释后必须是合法 JSON，且关键字段齐全。"""
import json, re, sys, pathlib
p = pathlib.Path(__file__).resolve().parents[1] / "realm" / "tri-realm.json"
raw = p.read_text(encoding="utf-8")
clean = re.sub(r"(?m)^\s*//.*$", "", raw)
clean = re.sub(r",(\s*[}\]])", r"\1", clean)
try:
    d = json.loads(clean)
except json.JSONDecodeError as e:
    sys.exit(f"✗ realm 模板不是合法 JSON：{e}")
required = ["realm", "clients", "authenticationFlows", "browserFlow"]
miss = [k for k in required if k not in d]
if miss:
    sys.exit(f"✗ 缺少字段：{miss}")
ids = [c["clientId"] for c in d["clients"]]
assert len(ids) == len(set(ids)), "clientId 重复"
print(f"✓ realm 模板合法：realm={d['realm']} clients={ids} flows={[f['alias'] for f in d['authenticationFlows']]}")
