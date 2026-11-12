#!/bin/bash
# 新闻抓取 -> 四类分类 -> 飞书分群推送   定时执行入口
cd /opt/newsbot || exit 1
/opt/newsbot/venv/bin/python /opt/newsbot/src/main.py >> /opt/newsbot/logs/cron.log 2>&1
