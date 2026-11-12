# ============================================================
# 企业统一身份平台（Keycloak）— 常用操作入口
# ============================================================
# 所有目标都只是 deploy/deploy.sh 的薄封装，方便不用记参数。
.PHONY: help build up nginx provision verify status logs backup down all

help:
	@sed -n '1,12p' Makefile
	@printf '\n可用目标：\n'
	@grep -E '^[a-z-]+:' Makefile | sed 's/:.*//' | awk '{printf "  %-10s\n", $$1}'

build: ; ./deploy/deploy.sh build
up: ; ./deploy/deploy.sh up
nginx: ; ./deploy/deploy.sh nginx
provision: ; ./deploy/deploy.sh provision
verify: ; ./deploy/deploy.sh verify $(USER) $(PASS)
status: ; ./deploy/deploy.sh status
logs: ; ./deploy/deploy.sh logs
backup: ; ./deploy/deploy.sh backup
down: ; ./deploy/deploy.sh down
all: ; ./deploy/deploy.sh all $(USER) $(PASS)
