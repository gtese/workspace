#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
we-mp-rss 公众号自动同步脚本
检测 we-mp-rss 中新增公众号，自动：
  1) 追加到两个定时采集任务（11:30 / 23:30）的 mps_id
  2) 追加到 /opt/newsbot/config/mp_sources.yaml
  3) 重载调度器（job/fresh）
  4) 生成变更日志
用法: python3 sync_mp.py [--dry-run]
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import urllib.parse

BASE = os.environ.get("WEMP_BASE", "http://127.0.0.1:8001")
LOG_FILE = "/opt/newsbot/logs/mp_sync.log"
MP_SOURCES = "/opt/newsbot/config/mp_sources.yaml"
TASKS = {
    "11:30": "a51a9390-2152-4b72-8ae2-4c71e0520571",
    "23:30": "dcbe54a4-a138-41da-a823-70a925ec85d6",
}

DRY = "--dry-run" in sys.argv


def http(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    data = json.dumps(body).encode() if body is not None else None
    with urllib.request.urlopen(req, data=data, timeout=30) as r:
        return json.loads(r.read().decode())


def log(msg):
    line = time.strftime("%Y-%m-%d %H:%M:%S") + " " + msg
    print(line)
    try:
        with open(LOG_FILE, "a") as f:
            f.write(line + "\n")
    except Exception as e:
        print("log write failed:", e)


def get_token():
    req = urllib.request.Request(BASE + "/api/v1/wx/auth/login", method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    # 凭据不入仓：部署时通过环境变量注入（WEMP_USER / WEMP_PASS）
    form = urllib.parse.urlencode({
        "username": os.environ.get("WEMP_USER", "admin"),
        "password": os.environ.get("WEMP_PASS", ""),
    }).encode()
    with urllib.request.urlopen(req, data=form, timeout=30) as r:
        return json.loads(r.read().decode())["data"]["access_token"]


def read_existing_ids():
    ids = set()
    if not os.path.exists(MP_SOURCES):
        return ids
    with open(MP_SOURCES) as f:
        for line in f:
            m = re.search(r'id:\s*"(MP_WXS_\d+)"', line)
            if m:
                ids.add(m.group(1))
    return ids


def append_to_yaml(names):
    lines = []
    with open(MP_SOURCES) as f:
        content = f.read()
    if not content.endswith("\n"):
        content += "\n"
    with open(MP_SOURCES, "a") as f:
        for name, mid in names:
            f.write('  - {name: "%s", id: "%s", enabled: true}\n' % (name, mid))
    log("mp_sources.yaml 追加 %d 个公众号" % len(names))


def get_task_mps(token, task_id):
    d = http("GET", "/api/v1/wx/message_tasks/" + task_id, token=token)
    task = d.get("data") or {}
    mps = json.loads(task.get("mps_id") or "[]")
    return task, mps


def update_task(token, task, task_id, mps):
    payload = {
        "name": task.get("name"),
        "cron_exp": task.get("cron_exp"),
        "status": task.get("status", 1),
        "message_type": task.get("message_type", 0),
        "message_template": task.get("message_template") or "",
        "web_hook_url": task.get("web_hook_url") or "",
        "headers": task.get("headers") or "",
        "cookies": task.get("cookies") or "",
        "mps_id": json.dumps([{"id": i} for i in mps]),
    }
    return http("PUT", "/api/v1/wx/message_tasks/" + task_id, payload, token)


def main():
    token = get_token()
    mps_resp = http("GET", "/api/v1/wx/mps", token=token)
    mp_list = mps_resp.get("data", {}).get("list", [])
    active = {m["id"]: m.get("mp_name", m["id"]) for m in mp_list if m.get("status") == 1}

    existing = read_existing_ids()
    new_ids = [mid for mid in active if mid not in existing]
    if not new_ids:
        log("sync: 无新增公众号，跳过")
        return

    new_names = [(active[mid], mid) for mid in new_ids]
    log("发现新增公众号: %s" % ", ".join("%s(%s)" % (n, i) for n, i in new_names))

    if DRY:
        log("[dry-run] 将追加到 mp_sources.yaml 与两个任务，本次不执行")
        return

    # 1. 备份 + 追加 mp_sources.yaml
    bak = MP_SOURCES + ".bak." + time.strftime("%Y%m%d%H%M%S")
    subprocess.run(["cp", MP_SOURCES, bak], check=True)
    log("已备份: %s" % bak)
    append_to_yaml(new_names)

    # 2. 更新两个任务
    for label, tid in TASKS.items():
        task, mps = get_task_mps(token, tid)
        existing_ids = set(mps)
        to_add = [i for i in new_ids if i not in existing_ids]
        if not to_add:
            log("任务 %s(%s) 已包含新增公众号，无需更新" % (label, tid))
            continue
        new_mps = mps + [{"id": i} for i in to_add]
        resp = update_task(token, task, tid, [m["id"] for m in new_mps])
        if resp.get("code") == 0:
            log("任务 %s(%s) 追加 %d 个，现有 %d 个" % (label, tid, len(to_add), len(new_mps)))
        else:
            log("任务 %s 更新失败: %s" % (label, resp))

    # 3. 重载调度器
    resp = http("PUT", "/api/v1/wx/message_tasks/job/fresh", None, token)
    log("调度器重载: %s" % (resp.get("message") or resp))

    # 4. 记录变更
    log("sync 完成，新增: %s" % ", ".join(i for _, i in new_names))


if __name__ == "__main__":
    main()
