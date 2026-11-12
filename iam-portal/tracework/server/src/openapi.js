/**
 * OpenAPI 3.0 规范生成。
 * 供 /api/v1/openapi.json 与 Swagger UI 使用。
 */

const bearer = [{ bearerAuth: [] }];

function paged(desc) {
  return {
    description: desc,
    parameters: [
      { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
      { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 50, maximum: 500 } },
    ],
    responses: { 200: { description: '成功' }, 401: { $ref: '#/components/responses/Unauthorized' } },
  };
}

export function buildOpenApi() {
  return {
    openapi: '3.0.3',
    info: {
      title: 'TraceWork API',
      version: '1.0.0',
      description: `
# TraceWork 科研项目职能支持平台 · 开放 API

通过 API 可以访问、控制、操作系统中的全部业务数据对象。

## 认证

支持两种方式，任选其一，放在请求头：

\`\`\`
Authorization: Bearer <凭证>
\`\`\`

### 方式一：API Key（推荐给系统集成）

在「系统管理 → API 密钥」创建，长期有效，可限定权限范围与过期时间。

### 方式二：账号密码换 Token（适合调试脚本）

\`POST /api/v1/auth/token\` 用 AD 账号密码换取 JWT，默认 2 小时有效。

## 权限模型

最终权限 = **API Key 的 scopes** ∩ **归属用户的角色**

即使 Key 授予了 \`*\$，也只能做该用户角色允许的事。

## 响应格式

成功：
\`\`\`json
{ "ok": true, "data": { ... } }
\`\`\`

失败：
\`\`\`json
{ "ok": false, "error": { "code": "FORBIDDEN", "message": "..." } }
\`\`\`

## 限流

按 Key 每分钟限流（默认 600 次），响应头返回
\`X-RateLimit-Limit\` / \`X-RateLimit-Remaining\`，超限返回 429。
`,
    },
    servers: [{ url: '/api/v1', description: '当前服务' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'API Key（twk_ 开头）或 JWT',
        },
      },
      responses: {
        Unauthorized: {
          description: '未认证',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', example: false },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'BAD_REQUEST' },
                message: { type: 'string' },
              },
            },
          },
        },
        Project: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            code: { type: 'string', example: 'RD-2026-001' },
            name: { type: 'string' },
            is_rnd: { type: 'boolean' },
            is_active: { type: 'boolean' },
            owner_id: { type: 'integer', nullable: true },
          },
        },
        TimeEntry: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            work_date: { type: 'string', format: 'date' },
            user_id: { type: 'integer' },
            username: { type: 'string' },
            project_id: { type: 'integer' },
            project_code: { type: 'string' },
            project_name: { type: 'string' },
            hours: { type: 'number', example: 8 },
            note: { type: 'string' },
          },
        },
        Asset: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            asset_no: { type: 'string', example: 'Tri-Asset-IT001' },
            device_type: { type: 'string' },
            brand: { type: 'string' },
            model: { type: 'string' },
            sn: { type: 'string', nullable: true },
            status: { type: 'string', enum: ['在用', '在库', '外借', '维修', '报废', '调拨'] },
            holder_id: { type: 'integer', nullable: true },
            holder_account: { type: 'string', nullable: true },
            borrower_external: { type: 'string', nullable: true },
          },
        },
        ApiKey: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            key_prefix: { type: 'string', example: 'twk_abc123de' },
            scopes: { type: 'array', items: { type: 'string' } },
            is_active: { type: 'boolean' },
            expires_at: { type: 'string', nullable: true },
            call_count: { type: 'integer' },
          },
        },
      },
    },
    security: bearer,
    tags: [
      { name: '认证', description: '获取 Token、查看身份' },
      { name: 'API 密钥', description: '密钥管理（仅管理员）' },
      { name: '项目', description: '研发项目管理' },
      { name: '用户', description: '用户档案' },
      { name: '工时', description: '工时填报与查询' },
      { name: '审批', description: '审批流转' },
      { name: '考勤', description: '考勤与日历' },
      { name: '费用', description: '费用归集与备查台账' },
      { name: '汇总', description: '月度汇总与多口径测算' },
      { name: '资料', description: '备查资料生成' },
      { name: '资产', description: 'IT 资产管理' },
      { name: '系统', description: '元数据与规范' },
    ],
    paths: {
      '/auth/token': {
        post: {
          tags: ['认证'],
          summary: '用 AD 账号密码换取 Token',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['username', 'password'],
                  properties: {
                    username: { type: 'string', example: 'linyiyao' },
                    password: { type: 'string', format: 'password' },
                    expiresInMinutes: { type: 'integer', default: 120, maximum: 1440 },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Token 签发成功' } },
        },
      },
      '/auth/whoami': {
        get: { tags: ['认证'], summary: '查看当前凭证身份与权限', responses: { 200: { description: 'OK' } } },
      },
      '/api-keys': {
        get: { tags: ['API 密钥'], summary: '列出所有 API 密钥', responses: { 200: { description: 'OK' } } },
        post: {
          tags: ['API 密钥'],
          summary: '创建 API 密钥（明文仅返回一次）',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string', example: 'BI 报表系统' },
                    ownerId: { type: 'integer', description: '归属用户，默认当前用户' },
                    scopes: {
                      type: 'array', items: { type: 'string' },
                      example: ['timesheet:read', 'project:read'],
                      description: '默认 ["*"]，但不能超出归属用户角色权限',
                    },
                    expiresAt: { type: 'string', example: '2027-01-01T00:00:00Z' },
                    rateLimitPerMin: { type: 'integer', default: 600 },
                  },
                },
              },
            },
          },
          responses: { 200: { description: '创建成功，data.key 为明文密钥' } },
        },
      },
      '/api-keys/scopes': {
        get: { tags: ['API 密钥'], summary: '列出全部权限范围', responses: { 200: { description: 'OK' } } },
      },
      '/api-keys/{id}': {
        delete: {
          tags: ['API 密钥'], summary: '吊销密钥',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { 200: { description: '已吊销' } },
        },
      },
      '/api-logs': {
        get: {
          tags: ['API 密钥'], summary: 'API 调用日志',
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } },
            { name: 'keyId', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/meta': {
        get: { tags: ['系统'], summary: '服务元数据（角色、权限范围、项目列表）', responses: { 200: { description: 'OK' } } },
      },
      '/projects': {
        get: {
          tags: ['项目'], summary: '项目列表',
          parameters: [{ name: 'activeOnly', in: 'query', schema: { type: 'string', enum: ['0', '1'] } }],
          responses: { 200: { description: 'OK' } },
        },
        post: {
          tags: ['项目'], summary: '新建项目',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object', required: ['code', 'name'],
                  properties: {
                    code: { type: 'string', example: 'RD-2026-100' },
                    name: { type: 'string' },
                    is_rnd: { type: 'boolean', default: true },
                    description: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: '创建成功' } },
        },
      },
      '/projects/{id}': {
        get: {
          tags: ['项目'], summary: '项目详情（含成员与审批人）',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { 200: { description: 'OK' } },
        },
        patch: {
          tags: ['项目'], summary: '修改项目',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { 200: { description: 'OK' } },
        },
        delete: {
          tags: ['项目'], summary: '删除项目（有业务数据时拒绝）',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { 200: { description: 'OK' }, 409: { description: '项目已有业务数据' } },
        },
      },
      '/projects/{id}/members': {
        put: {
          tags: ['项目'], summary: '设置项目成员（整表替换）',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { userIds: { type: 'array', items: { type: 'integer' } } },
                },
              },
            },
          },
          responses: { 200: { description: 'OK' } },
        },
      },
      '/projects/{id}/approvers': {
        put: {
          tags: ['项目'], summary: '设置项目审批人（或签，最多 20 位）',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { userIds: { type: 'array', items: { type: 'integer' } } },
                },
              },
            },
          },
          responses: { 200: { description: 'OK' } },
        },
      },
      '/users': {
        get: {
          tags: ['用户'], summary: '用户列表',
          parameters: [
            { name: 'activeOnly', in: 'query', schema: { type: 'string', enum: ['0', '1'] } },
            { name: 'role', in: 'query', schema: { type: 'string' } },
            { name: 'q', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/users/me': {
        get: { tags: ['用户'], summary: '当前用户信息', responses: { 200: { description: 'OK' } } },
      },
      '/users/{id}': {
        patch: {
          tags: ['用户'], summary: '修改用户档案',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/timesheets/{period}': {
        get: {
          tags: ['工时'], summary: '某月工时单与明细',
          parameters: [
            { name: 'period', in: 'path', required: true, schema: { type: 'string', example: '2026-10' } },
            { name: 'userId', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/timesheets/{period}/day': {
        put: {
          tags: ['工时'], summary: '保存某天填报（整日覆盖）',
          parameters: [{ name: 'period', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object', required: ['date', 'entries'],
                  properties: {
                    date: { type: 'string', format: 'date' },
                    entries: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          projectId: { type: 'integer' },
                          hours: { type: 'number', example: 4 },
                          note: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'OK' }, 409: { description: '本月已提交/已审批，不可修改' } },
        },
      },
      '/timesheets/{period}/submit': {
        post: {
          tags: ['工时'], summary: '提交本月报工',
          parameters: [{ name: 'period', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/timesheets/{period}/withdraw': {
        post: {
          tags: ['工时'], summary: '撤回本月报工',
          parameters: [{ name: 'period', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/entries': {
        get: {
          tags: ['工时'],
          summary: '工时明细查询（支持多维过滤与分页）',
          parameters: [
            { name: 'period', in: 'query', schema: { type: 'string', example: '2026-10' } },
            { name: 'userId', in: 'query', schema: { type: 'integer' } },
            { name: 'projectId', in: 'query', schema: { type: 'integer' } },
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
            { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 50 } },
          ],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/approvals': {
        get: {
          tags: ['审批'], summary: '审批收件箱',
          parameters: [
            { name: 'period', in: 'query', schema: { type: 'string' } },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'approved', 'rejected'] } },
          ],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/approvals/{id}/decide': {
        post: {
          tags: ['审批'], summary: '审批（或签）',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object', required: ['decision'],
                  properties: {
                    decision: { type: 'string', enum: ['approve', 'reject'] },
                    comment: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'OK' }, 409: { description: '该审批单已处理' } },
        },
      },
      '/attendance/{period}': {
        get: {
          tags: ['考勤'], summary: '某月考勤',
          parameters: [{ name: 'period', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/attendance/{period}/{userId}': {
        put: {
          tags: ['考勤'], summary: '设置某人某月考勤',
          parameters: [
            { name: 'period', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'userId', in: 'path', required: true, schema: { type: 'integer' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object', required: ['hours'],
                  properties: { hours: { type: 'number' }, workdays: { type: 'number' } },
                },
              },
            },
          },
          responses: { 200: { description: 'OK' } },
        },
        delete: {
          tags: ['考勤'], summary: '清除考勤记录',
          parameters: [
            { name: 'period', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'userId', in: 'path', required: true, schema: { type: 'integer' } },
          ],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/calendar/{period}': {
        get: {
          tags: ['考勤'], summary: '某月节假日日历',
          parameters: [{ name: 'period', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/cost-entries': {
        get: {
          tags: ['费用'], summary: '费用明细列表',
          parameters: [
            { name: 'period', in: 'query', schema: { type: 'string' } },
            { name: 'category', in: 'query', schema: { type: 'string', enum: ['labor', 'direct', 'dep', 'amort', 'design', 'other'] } },
            { name: 'projectId', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { 200: { description: 'OK' } },
        },
        post: { tags: ['费用'], summary: '新增费用明细', responses: { 200: { description: 'OK' } } },
      },
      '/cost-entries/{id}': {
        patch: {
          tags: ['费用'], summary: '修改费用明细',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { 200: { description: 'OK' } },
        },
        delete: {
          tags: ['费用'], summary: '删除费用明细',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/shared-expenses': {
        get: {
          tags: ['费用'], summary: '公共费用列表',
          parameters: [{ name: 'period', in: 'query', schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
        post: { tags: ['费用'], summary: '新增公共费用', responses: { 200: { description: 'OK' } } },
      },
      '/outsourcing': {
        get: { tags: ['费用'], summary: '委外/合作研发合同列表', responses: { 200: { description: 'OK' } } },
      },
      '/ledgers': {
        get: { tags: ['费用'], summary: '15 类备查台账目录', responses: { 200: { description: 'OK' } } },
      },
      '/ledgers/{key}': {
        get: {
          tags: ['费用'], summary: '某类台账数据',
          parameters: [
            { name: 'key', in: 'path', required: true, schema: { type: 'string', example: 'special' } },
            { name: 'period', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/ledgers/{key}/rows': {
        post: {
          tags: ['费用'], summary: '新增台账行',
          parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' }, 422: { description: '字段校验失败' } },
        },
      },
      '/ledgers/{key}/rows/{id}': {
        patch: {
          tags: ['费用'], summary: '修改台账行',
          parameters: [
            { name: 'key', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          ],
          responses: { 200: { description: 'OK' } },
        },
        delete: {
          tags: ['费用'], summary: '删除台账行',
          parameters: [
            { name: 'key', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
          ],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/summary/{period}': {
        get: {
          tags: ['汇总'], summary: '月度汇总',
          parameters: [
            { name: 'period', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'snapshot', in: 'query', schema: { type: 'string', enum: ['0', '1'] }, description: '1=生成分摊快照' },
          ],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/deduction/{period}': {
        get: {
          tags: ['汇总'], summary: '多口径研发费用测算',
          parameters: [
            { name: 'period', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'scope', in: 'query', schema: { type: 'string', enum: ['month', 'year'] } },
          ],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/labor-allocation/{period}': {
        get: {
          tags: ['汇总'], summary: '工时转人工费用预览',
          parameters: [{ name: 'period', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/documents': {
        get: {
          tags: ['资料'], summary: '备查资料模板与生成记录',
          parameters: [{ name: 'period', in: 'query', schema: { type: 'string' } }],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/documents/{key}/preview': {
        get: {
          tags: ['资料'], summary: '下载生成的 Word 文档',
          parameters: [
            { name: 'key', in: 'path', required: true, schema: { type: 'string', example: 't01' } },
            { name: 'period', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'docx 二进制流' } },
        },
      },
      '/documents/generate': {
        post: { tags: ['资料'], summary: '批量生成备查资料', responses: { 200: { description: 'OK' } } },
      },
      '/assets': {
        get: {
          tags: ['资产'], summary: 'IT 资产列表',
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string' } },
            { name: 'type', in: 'query', schema: { type: 'string' } },
            { name: 'q', in: 'query', schema: { type: 'string' } },
            { name: 'unassigned', in: 'query', schema: { type: 'string', enum: ['0', '1'] } },
          ],
          responses: { 200: { description: 'OK' } },
        },
        post: { tags: ['资产'], summary: '新增资产（使用人挂接 AD 账号）', responses: { 200: { description: 'OK' } } },
      },
      '/assets/stats': {
        get: { tags: ['资产'], summary: '资产统计', responses: { 200: { description: 'OK' } } },
      },
      '/assets/{id}': {
        get: {
          tags: ['资产'], summary: '资产详情与借用历史',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { 200: { description: 'OK' } },
        },
        patch: {
          tags: ['资产'], summary: '修改资产',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { 200: { description: 'OK' } },
        },
        delete: {
          tags: ['资产'], summary: '删除资产',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { 200: { description: 'OK' } },
        },
      },
      '/assets/{id}/return': {
        post: {
          tags: ['资产'], summary: '办理归还',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { 200: { description: 'OK' } },
        },
      },
    },
  };
}