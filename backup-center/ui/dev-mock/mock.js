/**
 * 开发环境 mock（仅挂载到 Vite dev server，不进入生产构建）。
 * 用法：npm run dev:mock，然后在登录页使用任意非空账号密码登录。
 */
import { randomBytes } from 'node:crypto'

const now = Date.now()
const isoAgo = (ms) => new Date(now - ms).toISOString()
const isoIn = (ms) => new Date(now + ms).toISOString()

let mockUser = {
  id: 'u_3a1c9e7b2d4f',
  username: 'admin',
  display_name: '管理员',
  role: 'admin',
}

let clients = [
  {
    id: 'c_1a2b3c4d5e6f',
    hostname: 'node-01',
    os: 'linux',
    arch: 'amd64',
    agent_version: '0.1.0',
    cert_serial: '5E3A91C47B2D806F',
    cert_fp: 'SHA256:5f8c1d2a9b7e4c3d1f6a8b0c9d2e5f7a1b3c4d6e8f0a2b4c6d8e1f3a5b7c9d0e',
    status: 'active',
    repository_id: 'r_1f2e3d4c5b6a',
    allowed_roots: '/home,/data,/etc',
    tags: 'prod,db',
    ip: '192.0.2.11',
    last_seen_at: isoAgo(45 * 1000),
    created_at: isoAgo(120 * 24 * 3600 * 1000),
    disks: [
      { path: '/', total: 100 * 1024 ** 3, free: 32 * 1024 ** 3 },
      { path: '/data', total: 2 * 1024 ** 4, free: 780 * 1024 ** 3 },
    ],
    mounts: [
      { path: '/', fs: 'xfs', total: 100 * 1024 ** 3, free: 32 * 1024 ** 3 },
      { path: '/data', fs: 'xfs', total: 2 * 1024 ** 4, free: 780 * 1024 ** 3 },
      { path: '/boot', fs: 'ext4', total: 1024 * 1024 ** 2, free: 620 * 1024 ** 2 },
    ],
  },
  {
    id: 'c_2b3c4d5e6f70',
    hostname: 'file-01',
    os: 'linux',
    arch: 'amd64',
    agent_version: '0.1.0',
    cert_serial: '91C47B2D806F5E3A',
    cert_fp: 'SHA256:9a7e4c3d1f6a8b0c9d2e5f7a1b3c4d6e8f0a2b4c6d8e1f3a5b7c9d0e5f8c1d2a',
    status: 'active',
    repository_id: 'r_2a3b4c5d6e7f',
    allowed_roots: '/home,/srv',
    tags: 'prod,file',
    ip: '192.0.2.12',
    last_seen_at: isoAgo(3 * 60 * 1000),
    created_at: isoAgo(90 * 24 * 3600 * 1000),
    disks: [{ path: '/', total: 500 * 1024 ** 3, free: 210 * 1024 ** 3 }],
    mounts: [{ path: '/', fs: 'ext4', total: 500 * 1024 ** 3, free: 210 * 1024 ** 3 }],
  },
  {
    id: 'c_3c4d5e6f7081',
    hostname: 'mac-test',
    os: 'darwin',
    arch: 'arm64',
    agent_version: '0.0.9',
    cert_serial: '806F5E3A91C47B2D',
    cert_fp: 'SHA256:1d2a9b7e4c3d1f6a8b0c9d2e5f7a1b3c4d6e8f0a2b4c6d8e1f3a5b7c9d0e5f8c',
    status: 'disabled',
    repository_id: 'r_1f2e3d4c5b6a',
    allowed_roots: '/Users',
    tags: 'test',
    ip: '192.0.2.13',
    last_seen_at: isoAgo(6 * 24 * 3600 * 1000),
    created_at: isoAgo(30 * 24 * 3600 * 1000),
  },
]

let enrollRequests = [
  {
    id: 'e_11a22b33c44d',
    hostname: 'node-02',
    os: 'rocky',
    arch: 'amd64',
    agent_version: '0.1.0',
    fingerprint: 'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90',
    ip: '192.0.2.14',
    status: 'pending',
    created_at: isoAgo(12 * 60 * 1000),
    expires_at: isoIn(48 * 60 * 1000),
    csr_pem:
      '-----BEGIN CERTIFICATE REQUEST-----\nMIICvTCCAaUCAQAwHjEcMBoGA1UEAwwTZWRhMTQwLmRlbW8ubG9jYWwwggEiMA0G\n（mock 数据，仅开发环境）\n-----END CERTIFICATE REQUEST-----',
  },
  {
    id: 'e_22b33c44d55e',
    hostname: 'db-02',
    os: 'linux',
    arch: 'amd64',
    agent_version: '0.1.0',
    fingerprint: 'B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90B2',
    ip: '192.0.2.15',
    status: 'pending',
    created_at: isoAgo(4 * 60 * 1000),
    expires_at: isoIn(56 * 60 * 1000),
    csr_pem:
      '-----BEGIN CERTIFICATE REQUEST-----\nMIICvTCCAaUCAQAwHjEcMBoGA1UEAwwTZGJzZXJ2ZXIwMi5kZW1vLmxvY2Fs\n（mock 数据，仅开发环境）\n-----END CERTIFICATE REQUEST-----',
  },
  {
    id: 'e_33c44d55e66f',
    hostname: 'file-02',
    os: 'linux',
    arch: 'amd64',
    agent_version: '0.1.0',
    fingerprint: 'C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90B2C3',
    ip: '192.0.2.16',
    status: 'approved',
    created_at: isoAgo(2 * 24 * 3600 * 1000),
    expires_at: isoAgo(23 * 3600 * 1000),
    approved_at: isoAgo(47 * 3600 * 1000),
    approved_by: 'admin',
    client_id: 'c_2b3c4d5e6f70',
  },
  {
    id: 'e_44d55e66f770',
    hostname: 'unknown-host',
    os: 'linux',
    arch: 'arm64',
    agent_version: '0.0.8',
    fingerprint: 'D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90B2C3D4',
    ip: '192.0.2.17',
    status: 'rejected',
    created_at: isoAgo(5 * 24 * 3600 * 1000),
    expires_at: isoAgo(4 * 24 * 3600 * 1000),
  },
]

let repositories = [
  {
    id: 'r_1f2e3d4c5b6a',
    name: 'backup-main',
    type: 'local',
    rest_port: 8001,
    status: 'active',
    total_bytes: 4 * 1024 ** 4,
    free_bytes: 2100 * 1024 ** 3,
    config: { type: 'local', path: '/data2/backup/restic' },
    mountpoint: '/data2/backup/restic',
    created_at: isoAgo(120 * 24 * 3600 * 1000),
    last_checked_at: isoAgo(35 * 60 * 1000),
  },
  {
    id: 'r_2a3b4c5d6e7f',
    name: 'nfs-archive',
    type: 'nfs',
    rest_port: 8002,
    status: 'active',
    total_bytes: 10 * 1024 ** 4,
    free_bytes: 6400 * 1024 ** 3,
    config: { type: 'nfs', server: '192.0.2.13', export: '/fs/backup', options: 'rw,hard,vers=4.1' },
    mountpoint: '/mnt/nfs-archive',
    created_at: isoAgo(80 * 24 * 3600 * 1000),
    last_checked_at: isoAgo(3 * 3600 * 1000),
  },
  {
    id: 'r_3b4c5d6e7f80',
    name: 'cifs-share',
    type: 'cifs',
    rest_port: 8003,
    status: 'degraded',
    total_bytes: 7 * 1024 ** 4,
    free_bytes: 1200 * 1024 ** 3,
    config: { type: 'cifs', server: 'smb.example.com', share: 'backup', username: 'svc-backup', domain: 'TRI', vers: '3.0' },
    mountpoint: '/mnt/cifs-share',
    created_at: isoAgo(60 * 24 * 3600 * 1000),
    last_checked_at: isoAgo(26 * 3600 * 1000),
  },
]

let plans = [
  {
    id: 'p_1a2b3c4d5e6f',
    name: 'node-01 每日全量',
    client_id: 'c_1a2b3c4d5e6f',
    repository_id: 'r_1f2e3d4c5b6a',
    paths: ['/home/docs', '/data/app'],
    excludes: ['*.tmp', '.cache', 'node_modules'],
    cron: '0 2 * * *',
    window: { start: '22:00', end: '06:00', skip_outside: true },
    compression: 'auto',
    limit_upload_kib: 0,
    retention: { keep_last: 5, keep_daily: 7, keep_weekly: 4, keep_monthly: 6, keep_yearly: 1, prune_after_backup: true },
    hooks: { pre: null, post: null },
    enabled: 1,
    created_by: 'admin',
    created_at: isoAgo(60 * 24 * 3600 * 1000),
    next_run_at: isoIn(9 * 3600 * 1000),
    last_run_at: isoAgo(15 * 3600 * 1000),
  },
  {
    id: 'p_2b3c4d5e6f70',
    name: 'file-01 文件归档',
    client_id: 'c_2b3c4d5e6f70',
    repository_id: 'r_2a3b4c5d6e7f',
    paths: ['/home', '/srv/files'],
    excludes: ['*.log', 'lost+found'],
    cron: '30 1 * * 1-5',
    window: { start: '23:00', end: '05:00', skip_outside: true },
    compression: 'auto',
    limit_upload_kib: 20480,
    retention: { keep_last: 3, keep_daily: 7, keep_weekly: 4, keep_monthly: 6, keep_yearly: 1, prune_after_backup: true },
    hooks: { pre: 'systemctl stop filesvc', post: 'systemctl start filesvc' },
    enabled: 1,
    created_by: 'admin',
    created_at: isoAgo(45 * 24 * 3600 * 1000),
    next_run_at: isoIn(6 * 3600 * 1000),
    last_run_at: isoAgo(18 * 3600 * 1000),
  },
  {
    id: 'p_3c4d5e6f7081',
    name: 'mac-test 桌面备份',
    client_id: 'c_3c4d5e6f7081',
    repository_id: 'r_1f2e3d4c5b6a',
    paths: ['/Users/test/Documents'],
    excludes: ['.DS_Store'],
    cron: '0 3 * * 0',
    window: { start: '22:00', end: '06:00', skip_outside: false },
    compression: 'off',
    limit_upload_kib: 0,
    retention: { keep_last: 2, keep_daily: 0, keep_weekly: 2, keep_monthly: 0, keep_yearly: 0, prune_after_backup: false },
    hooks: { pre: null, post: null },
    enabled: 0,
    created_by: 'admin',
    created_at: isoAgo(20 * 24 * 3600 * 1000),
    next_run_at: null,
    last_run_at: isoAgo(8 * 24 * 3600 * 1000),
  },
]

const runStatuses = ['success', 'success', 'success', 'failed', 'success', 'success', 'canceled', 'success', 'success', 'running', 'queued', 'success', 'failed', 'success']
let runs = runStatuses.map((status, index) => {
  const plan = plans[index % 3]
  const startedAgo = (index === 9 ? 4 : index === 10 ? 0 : index + 1) * 3600 * 1000 + index * 17 * 60 * 1000
  const running = status === 'running'
  const queued = status === 'queued'
  const started = queued ? null : isoAgo(startedAgo)
  const finished = running || queued ? null : isoAgo(Math.max(0, startedAgo - (18 + index) * 60 * 1000))
  const filesNew = status === 'failed' ? 120 : 300 + index * 57
  return {
    id: `run_${(index + 11).toString(16).padStart(2, '0')}${'ab12cd34ef56'.slice(0, 12)}`,
    plan_id: plan.id,
    client_id: plan.client_id,
    repository_id: plan.repository_id,
    trigger: index === 10 ? 'manual' : 'schedule',
    status,
    started_at: started,
    finished_at: finished,
    snapshot_id: status === 'success' ? snapshotId(index) : null,
    files_new: status === 'success' ? filesNew : 0,
    files_changed: status === 'success' ? 21 + index : 0,
    files_unmodified: status === 'success' ? 4210 + index * 30 : 0,
    bytes_added: status === 'success' ? filesNew * 1024 * (index + 2) : 0,
    bytes_processed: status === 'success' ? 3.2 * 1024 ** 3 + index * 1024 ** 2 : 0,
    error: status === 'failed' ? 'restic: repository is already locked (exit 11)；请确认前一个任务已结束' : null,
    log_tail: [
      `[INFO] 计划 ${plan.name} 开始执行`,
      '[INFO] 加载排除规则 3 条',
      status === 'failed' ? '[ERROR] restic backup failed: repository is already locked' : '[INFO] 扫描完成，开始上传',
      status === 'success' ? '[INFO] 快照创建完成，执行保留策略 prune' : '',
    ]
      .filter(Boolean)
      .join('\n'),
    progress: running
      ? { percent: 42, bytes_done: 1.4 * 1024 ** 3, bytes_total: 3.3 * 1024 ** 3, files_done: 860, files_total: 2043, current_path: '/data/app/uploads/2026/11', message: '正在上传数据' }
      : null,
  }
})

let restores = [
  {
    id: 'rst_11aa22bb33cc',
    client_id: 'c_1a2b3c4d5e6f',
    repository_id: 'r_1f2e3d4c5b6a',
    snapshot_id: snapshotId(0),
    includes_json: JSON.stringify(['/home/docs/report.txt']),
    target: '/tmp/restore',
    overwrite: 'if-changed',
    dry_run: 0,
    status: 'success',
    created_by: 'admin',
    created_at: isoAgo(26 * 3600 * 1000),
    finished_at: isoAgo(25.6 * 3600 * 1000),
    error: null,
    log_tail: '[INFO] 恢复完成，校验通过 1 个文件',
  },
  {
    id: 'rst_22bb33cc44dd',
    client_id: 'c_2b3c4d5e6f70',
    repository_id: 'r_2a3b4c5d6e7f',
    snapshot_id: snapshotId(3),
    includes_json: JSON.stringify(['/srv/files']),
    target: '/',
    overwrite: 'never',
    dry_run: 1,
    status: 'success',
    created_by: 'operator',
    created_at: isoAgo(50 * 3600 * 1000),
    finished_at: isoAgo(49.5 * 3600 * 1000),
    error: null,
    log_tail: '[INFO] dry-run 完成，未写入任何文件',
  },
  {
    id: 'rst_33cc44dd55ee',
    client_id: 'c_1a2b3c4d5e6f',
    repository_id: 'r_1f2e3d4c5b6a',
    snapshot_id: snapshotId(1),
    includes_json: JSON.stringify(['/home/docs/project']),
    target: '/tmp/restore',
    overwrite: 'always',
    dry_run: 0,
    status: 'failed',
    created_by: 'admin',
    created_at: isoAgo(70 * 3600 * 1000),
    finished_at: isoAgo(69.5 * 3600 * 1000),
    error: '目标磁盘空间不足',
    log_tail: '[ERROR] 恢复失败：目标路径空间不足',
  },
]

let users = [
  { id: 'u_3a1c9e7b2d4f', username: 'admin', display_name: '管理员', email: 'admin@example.com', role: 'admin', source: 'local', enabled: 1, created_at: isoAgo(120 * 24 * 3600 * 1000), last_login_at: isoAgo(10 * 60 * 1000) },
  { id: 'u_4b2d0f8c3e5a', username: 'operator', display_name: '运维值班', email: 'ops@example.com', role: 'operator', source: 'oidc', enabled: 1, created_at: isoAgo(90 * 24 * 3600 * 1000), last_login_at: isoAgo(3 * 3600 * 1000) },
  { id: 'u_5c3e1a9d4f6b', username: 'viewer', display_name: '只读用户', email: 'viewer@example.com', role: 'viewer', source: 'local', enabled: 1, created_at: isoAgo(60 * 24 * 3600 * 1000), last_login_at: isoAgo(2 * 24 * 3600 * 1000) },
  { id: 'u_6d4f2b0e5a7c', username: 'auditor', display_name: '安全审计', email: 'audit@example.com', role: 'auditor', source: 'oidc', enabled: 1, created_at: isoAgo(45 * 24 * 3600 * 1000), last_login_at: isoAgo(5 * 24 * 3600 * 1000) },
  { id: 'u_7e5a3c1f6b8d', username: 'disabled-user', display_name: '离职账号', email: 'left@example.com', role: 'viewer', source: 'local', enabled: 0, created_at: isoAgo(30 * 24 * 3600 * 1000), last_login_at: null },
]

let alertsSettings = {
  smtp: {
    enabled: true,
    host: 'smtp.example.com',
    port: 587,
    tls: true,
    username: 'backup-center',
    password: '***',
    from: 'backup-center@example.com',
    to: ['ops@example.com', 'dba@example.com'],
  },
  webhook: {
    enabled: false,
    url: 'https://hooks.example.com/backup',
    secret: '***',
  },
}

const generalSettings = {
  site_name: 'backup-center',
  default_repository_id: repositories[0].id,
  timezone: 'Asia/Shanghai',
  retention_default: { keep_last: 5, keep_daily: 7, keep_weekly: 4, keep_monthly: 6, keep_yearly: 1, prune_after_backup: true },
  window_default: { start: '22:00', end: '06:00', skip_outside: true },
  oidc: {
    issuer: 'https://<KEYCLOAK_HOST>/realms/<REALM>',
    client_id: 'backup-center',
    admin_group: 'backup-admins',
    operator_group: 'backup-operators',
  },
}

const auditActions = [
  ['admin', 'auth.login', 'session', 'success'],
  ['admin', 'client.approve', 'c_2b3c4d5e6f70', 'success'],
  ['admin', 'plan.run', 'p_1a2b3c4d5e6f', 'success'],
  ['operator', 'snapshot.restore', 'snap:11a22b33', 'success'],
  ['admin', 'snapshot.download', '/home/docs/report.txt', 'success'],
  ['operator', 'repository.validate', 'r_2a3b4c5d6e7f', 'success'],
  ['admin', 'client.disable', 'c_3c4d5e6f7081', 'success'],
  ['viewer', 'snapshot.download', '/srv/files/a.txt', 'forbidden'],
  ['admin', 'user.update', 'u_4b2d0f8c3e5a', 'success'],
  ['operator', 'run.cancel', 'run_1b', 'success'],
  ['admin', 'settings.update', 'alerts', 'success'],
  ['auditor', 'audit.query', 'audit_log', 'success'],
]
let auditLog = Array.from({ length: 68 }, (_, index) => {
  const item = auditActions[index % auditActions.length]
  return {
    id: index + 1,
    at: isoAgo(index * 37 * 60 * 1000 + 5 * 60 * 1000),
    actor: item[0],
    action: item[1],
    target: item[2],
    result: item[3],
    ip: index % 3 === 0 ? '198.51.100.21' : '198.51.100.22',
    detail_json: JSON.stringify({ request_id: `mock-${index}`, note: '开发环境模拟审计记录' }),
  }
})

const FS = {
  '/': [
    { name: 'home', path: '/home', type: 'dir', size: 0, mode: '0755', mtime: isoAgo(3600 * 1000) },
    { name: 'data', path: '/data', type: 'dir', size: 0, mode: '0755', mtime: isoAgo(7200 * 1000) },
    { name: 'etc', path: '/etc', type: 'dir', size: 0, mode: '0755', mtime: isoAgo(86400 * 1000) },
    { name: 'srv', path: '/srv', type: 'dir', size: 0, mode: '0755', mtime: isoAgo(86400 * 1000) },
  ],
  '/home': [
    { name: 'docs', path: '/home/docs', type: 'dir', size: 0, mode: '0755', mtime: isoAgo(3600 * 1000) },
    { name: 'alice', path: '/home/alice', type: 'dir', size: 0, mode: '0700', mtime: isoAgo(7200 * 1000) },
    { name: 'README.md', path: '/home/README.md', type: 'file', size: 4821, mode: '0644', mtime: isoAgo(2 * 3600 * 1000) },
  ],
  '/home/docs': [
    { name: 'project', path: '/home/docs/project', type: 'dir', size: 0, mode: '0755', mtime: isoAgo(1800 * 1000) },
    { name: 'report.txt', path: '/home/docs/report.txt', type: 'file', size: 20480, mode: '0644', mtime: isoAgo(5400 * 1000) },
    { name: 'config.yaml', path: '/home/docs/config.yaml', type: 'file', size: 1024, mode: '0640', mtime: isoAgo(3 * 3600 * 1000) },
    { name: 'latest', path: '/home/docs/latest', type: 'link', size: 0, mode: '0777', mtime: isoAgo(4 * 3600 * 1000), link_target: '/home/docs/project' },
  ],
  '/home/docs/project': [
    { name: 'src', path: '/home/docs/project/src', type: 'dir', size: 0, mode: '0755', mtime: isoAgo(1800 * 1000) },
    { name: 'dist', path: '/home/docs/project/dist', type: 'dir', size: 0, mode: '0755', mtime: isoAgo(1800 * 1000) },
    { name: 'package.json', path: '/home/docs/project/package.json', type: 'file', size: 2048, mode: '0644', mtime: isoAgo(3600 * 1000) },
    { name: 'README.md', path: '/home/docs/project/README.md', type: 'file', size: 8192, mode: '0644', mtime: isoAgo(3600 * 1000) },
  ],
  '/home/docs/project/src': [
    { name: 'main.js', path: '/home/docs/project/src/main.js', type: 'file', size: 4096, mode: '0644', mtime: isoAgo(1800 * 1000) },
    { name: 'utils.js', path: '/home/docs/project/src/utils.js', type: 'file', size: 2048, mode: '0644', mtime: isoAgo(1800 * 1000) },
    { name: 'config', path: '/home/docs/project/src/config', type: 'dir', size: 0, mode: '0755', mtime: isoAgo(1800 * 1000) },
  ],
  '/home/docs/project/src/config': [
    { name: 'default.json', path: '/home/docs/project/src/config/default.json', type: 'file', size: 1024, mode: '0644', mtime: isoAgo(1800 * 1000) },
  ],
  '/home/docs/project/dist': [
    { name: 'app.bundle.js', path: '/home/docs/project/dist/app.bundle.js', type: 'file', size: 2048 * 1024, mode: '0644', mtime: isoAgo(1800 * 1000) },
  ],
  '/home/alice': [
    { name: '.bashrc', path: '/home/alice/.bashrc', type: 'file', size: 512, mode: '0644', mtime: isoAgo(7200 * 1000) },
    { name: 'notes', path: '/home/alice/notes', type: 'dir', size: 0, mode: '0755', mtime: isoAgo(7200 * 1000) },
  ],
  '/home/alice/notes': [
    { name: 'todo.md', path: '/home/alice/notes/todo.md', type: 'file', size: 256, mode: '0644', mtime: isoAgo(7200 * 1000) },
  ],
  '/data': [
    { name: 'app', path: '/data/app', type: 'dir', size: 0, mode: '0755', mtime: isoAgo(1800 * 1000) },
    { name: 'backups', path: '/data/backups', type: 'dir', size: 0, mode: '0755', mtime: isoAgo(86400 * 1000) },
    { name: 'bigfile.iso', path: '/data/bigfile.iso', type: 'file', size: 3 * 1024 ** 3, mode: '0644', mtime: isoAgo(7 * 86400 * 1000) },
  ],
  '/data/app': [
    { name: 'uploads', path: '/data/app/uploads', type: 'dir', size: 0, mode: '0755', mtime: isoAgo(1800 * 1000) },
    { name: 'conf', path: '/data/app/conf', type: 'dir', size: 0, mode: '0750', mtime: isoAgo(1800 * 1000) },
    { name: 'app.log', path: '/data/app/app.log', type: 'file', size: 1024 * 1024, mode: '0644', mtime: isoAgo(600 * 1000) },
  ],
  '/data/app/uploads': [
    { name: '2026', path: '/data/app/uploads/2026', type: 'dir', size: 0, mode: '0755', mtime: isoAgo(1800 * 1000) },
    { name: 'avatar.png', path: '/data/app/uploads/avatar.png', type: 'file', size: 1024 * 512, mode: '0644', mtime: isoAgo(2 * 86400 * 1000) },
  ],
  '/data/app/uploads/2026': [
    { name: '11', path: '/data/app/uploads/2026/11', type: 'dir', size: 0, mode: '0755', mtime: isoAgo(1800 * 1000) },
  ],
  '/data/app/uploads/2026/11': [
    { name: 'report-11.pdf', path: '/data/app/uploads/2026/11/report-11.pdf', type: 'file', size: 2 * 1024 * 1024, mode: '0644', mtime: isoAgo(1800 * 1000) },
  ],
  '/data/app/conf': [
    { name: 'app.json', path: '/data/app/conf/app.json', type: 'file', size: 2048, mode: '0640', mtime: isoAgo(1800 * 1000) },
  ],
  '/data/backups': [
    { name: 'readme.txt', path: '/data/backups/readme.txt', type: 'file', size: 128, mode: '0644', mtime: isoAgo(5 * 86400 * 1000) },
  ],
  '/etc': [
    { name: 'hosts', path: '/etc/hosts', type: 'file', size: 512, mode: '0644', mtime: isoAgo(86400 * 1000) },
    { name: 'passwd', path: '/etc/passwd', type: 'file', size: 2048, mode: '0644', mtime: isoAgo(86400 * 1000) },
    { name: 'nginx', path: '/etc/nginx', type: 'dir', size: 0, mode: '0755', mtime: isoAgo(86400 * 1000) },
  ],
  '/etc/nginx': [
    { name: 'nginx.conf', path: '/etc/nginx/nginx.conf', type: 'file', size: 4096, mode: '0644', mtime: isoAgo(86400 * 1000) },
  ],
  '/srv': [
    { name: 'files', path: '/srv/files', type: 'dir', size: 0, mode: '0755', mtime: isoAgo(86400 * 1000) },
  ],
  '/srv/files': [
    { name: 'a.txt', path: '/srv/files/a.txt', type: 'file', size: 1024, mode: '0644', mtime: isoAgo(86400 * 1000) },
    { name: 'docs', path: '/srv/files/docs', type: 'dir', size: 0, mode: '0755', mtime: isoAgo(86400 * 1000) },
  ],
  '/srv/files/docs': [
    { name: 'spec.pdf', path: '/srv/files/docs/spec.pdf', type: 'file', size: 512 * 1024, mode: '0644', mtime: isoAgo(86400 * 1000) },
  ],
  '/Users': [
    { name: 'test', path: '/Users/test', type: 'dir', size: 0, mode: '0755', mtime: isoAgo(86400 * 1000) },
  ],
  '/Users/test': [
    { name: 'Documents', path: '/Users/test/Documents', type: 'dir', size: 0, mode: '0755', mtime: isoAgo(86400 * 1000) },
  ],
  '/Users/test/Documents': [
    { name: 'notes.md', path: '/Users/test/Documents/notes.md', type: 'file', size: 1024, mode: '0644', mtime: isoAgo(86400 * 1000) },
  ],
}

function snapshotId(seed) {
  const byte = (seed + 1).toString(16).padStart(2, '0')
  return byte.repeat(32)
}

function mockSnapshots(clientId) {
  const plan = plans.find((item) => item.client_id === clientId)
  const ages = [1.2, 7.5, 24.3, 49, 73.6, 120]
  return ages.map((hours, index) => {
    const id = snapshotId(index)
    const tags = plan ? [`plan:${plan.id}`] : []
    if (index === 2) tags.push('pinned')
    return {
      id,
      short_id: id.slice(0, 8),
      time: isoAgo(hours * 3600 * 1000),
      hostname: clients.find((client) => client.id === clientId)?.hostname || 'unknown',
      paths: plan?.paths || ['/'],
      tags,
      pinned: index === 2,
      summary: {
        total_files_processed: 2400 + index * 130,
        total_bytes_processed: 3.1 * 1024 ** 3 + index * 180 * 1024 ** 2,
        total_bytes_added: 210 * 1024 ** 2 + index * 12 * 1024 ** 2,
      },
    }
  })
}

const mounts = clients[0].mounts

function findClient(id) {
  return clients.find((client) => client.id === id)
}

function randomId(prefix, length = 12) {
  return `${prefix}_${randomBytes(length / 2).toString('hex')}`
}

function send(res, status, data, headers = {}) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
  res.end(data === undefined ? '' : JSON.stringify(data))
}

function fail(res, status, code, message) {
  send(res, status, { error: { code, message } })
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 5 * 1024 * 1024) req.destroy()
    })
    req.on('end', () => {
      if (!data) return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch {
        resolve({})
      }
    })
  })
}

function hasSession(req) {
  return /(?:^|;\s*)bc_mock_sid=1(?:;|$)/.test(req.headers.cookie || '')
}

function pathOf(url) {
  const raw = url.searchParams.get('path') || '/'
  return raw.startsWith('/') ? raw.replace(/\/+$/, '') || '/' : '/'
}

function entriesFor(path) {
  return FS[path] || []
}

function logLine(message) {
  return `event: log\ndata: ${JSON.stringify({ line: message })}\n\n`
}

function streamEvents(req, res, kind, task) {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  const terminal = ['success', 'failed', 'canceled', 'skipped'].includes(task.status)
  if (terminal) {
    res.write(`event: progress\ndata: ${JSON.stringify({ percent: task.status === 'success' ? 100 : 80, status: task.status })}\n\n`)
    res.write(logLine(`任务已结束：${task.status}`))
    res.write(`event: done\ndata: ${JSON.stringify({ status: task.status })}\n\n`)
    res.end()
    return
  }

  let ticks = 0
  const timer = setInterval(() => {
    ticks += 1
    const percent = Math.min(96, 20 + ticks * 9)
    res.write(
      `event: progress\ndata: ${JSON.stringify({
        percent,
        status: 'running',
        bytes_done: Math.round((3.3 * 1024 ** 3 * percent) / 100),
        bytes_total: 3.3 * 1024 ** 3,
        files_done: 400 + ticks * 90,
        files_total: 2043,
        current_path: `/data/app/uploads/chunk-${ticks}.bin`,
        message: '正在上传数据',
      })}\n\n`,
    )
    res.write(logLine(`[INFO] 上传分片 ${ticks} 完成（${percent}%）`))
    if (ticks >= 6) {
      clearInterval(timer)
      res.write(`event: done\ndata: ${JSON.stringify({ status: 'success', snapshot_id: snapshotId(0) })}\n\n`)
      task.status = 'success'
      if (kind === 'run') {
        task.finished_at = new Date().toISOString()
        task.snapshot_id = snapshotId(0)
      }
      res.end()
    }
  }, 900)

  req.on('close', () => clearInterval(timer))
}

async function handle(req, res, url) {
  const method = req.method || 'GET'
  const p = url.pathname

  if (p === '/healthz') {
    return send(res, 200, { ok: true, version: '1.0.0-mock', db: 'ok', rest_servers: 2 })
  }

  if (p === '/auth/oidc/start') {
    res.statusCode = 302
    res.setHeader('Set-Cookie', 'bc_mock_sid=1; Path=/; HttpOnly; SameSite=Lax')
    res.setHeader('Location', '/')
    return res.end()
  }

  if (p === '/api/auth/login' && method === 'POST') {
    const body = await readBody(req)
    if (!body.username || !body.password) {
      return fail(res, 400, 'validation', '请输入账号和密码')
    }
    mockUser = {
      ...mockUser,
      username: String(body.username),
      display_name: String(body.username) === 'admin' ? '管理员' : String(body.username),
    }
    return send(res, 200, { ok: true, user: mockUser }, {
      'Set-Cookie': 'bc_mock_sid=1; Path=/; HttpOnly; SameSite=Lax',
    })
  }

  if (p === '/api/auth/logout' && method === 'POST') {
    return send(res, 200, { ok: true }, {
      'Set-Cookie': 'bc_mock_sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
    })
  }

  if (!hasSession(req)) {
    return fail(res, 401, 'unauthorized', '未登录（mock 模式请输入任意非空账号密码）')
  }

  if (p === '/api/auth/me') {
    return send(res, 200, { user: mockUser, csrf: 'mock-csrf-token' })
  }

  // 节点
  if (p === '/api/clients' && method === 'GET') {
    return send(res, 200, clients.map(({ disks, mounts: clientMounts, ...client }) => client))
  }

  let match = p.match(/^\/api\/clients\/([^/]+)$/)
  if (match) {
    const client = findClient(decodeURIComponent(match[1]))
    if (!client) return fail(res, 404, 'not_found', '节点不存在')
    if (method === 'GET') return send(res, 200, client)
    if (method === 'PATCH') {
      const body = await readBody(req)
      Object.assign(client, body)
      return send(res, 200, { client })
    }
    if (method === 'DELETE') {
      clients = clients.filter((item) => item.id !== client.id)
      return send(res, 200, { ok: true })
    }
  }

  match = p.match(/^\/api\/clients\/([^/]+)\/(enable|disable)$/)
  if (match && method === 'POST') {
    const client = findClient(decodeURIComponent(match[1]))
    if (!client) return fail(res, 404, 'not_found', '节点不存在')
    client.status = match[2] === 'enable' ? 'active' : 'disabled'
    return send(res, 200, { ok: true, client })
  }

  match = p.match(/^\/api\/clients\/([^/]+)\/fs$/)
  if (match && method === 'GET') {
    const path = pathOf(url)
    return send(res, 200, {
      path,
      parent: path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/',
      entries: entriesFor(path),
      mounts,
    })
  }

  match = p.match(/^\/api\/clients\/([^/]+)\/snapshots$/)
  if (match && method === 'GET') {
    return send(res, 200, { snapshots: mockSnapshots(decodeURIComponent(match[1])) })
  }

  // 注册审批
  if (p === '/api/enroll-requests') {
    if (method === 'GET') {
      const status = url.searchParams.get('status')
      return send(res, 200, status ? enrollRequests.filter((item) => item.status === status) : enrollRequests)
    }
    if (method === 'POST') {
      const body = await readBody(req)
      const id = randomId('e', 16)
      const request = {
        id,
        hostname_hint: body.hostname_hint || '新节点',
        hostname: null,
        os: null,
        arch: null,
        status: 'pending',
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + (Number(body.ttl_minutes) || 60) * 60 * 1000).toISOString(),
        repository_id: body.repository_id || null,
      }
      enrollRequests = [request, ...enrollRequests]
      return send(res, 201, {
        id,
        token: 'mock-one-time-token-not-for-production',
        expires_at: request.expires_at,
        command: `sudo backup-center-agent enroll --server <BACKUP_CENTER_URL> --token <一次性令牌>`,
      })
    }
  }

  match = p.match(/^\/api\/enroll-requests\/([^/]+)$/)
  if (match && method === 'GET') {
    const request = enrollRequests.find((item) => item.id === decodeURIComponent(match[1]))
    if (!request) return fail(res, 404, 'not_found', '注册请求不存在')
    return send(res, 200, request)
  }

  match = p.match(/^\/api\/enroll-requests\/([^/]+)\/(approve|reject)$/)
  if (match && method === 'POST') {
    const request = enrollRequests.find((item) => item.id === decodeURIComponent(match[1]))
    if (!request) return fail(res, 404, 'not_found', '注册请求不存在')
    if (request.status !== 'pending') return fail(res, 409, 'conflict', '该请求已处理')
    if (match[2] === 'approve') {
      const clientId = randomId('c', 12)
      request.status = 'approved'
      request.client_id = clientId
      request.approved_at = new Date().toISOString()
      request.approved_by = mockUser.username
      clients = [
        {
          id: clientId,
          hostname: request.hostname || request.hostname_hint || 'new-node',
          os: request.os || 'linux',
          arch: request.arch || 'amd64',
          agent_version: request.agent_version || '0.1.0',
          cert_serial: randomBytes(8).toString('hex').toUpperCase(),
          cert_fp: `SHA256:${randomBytes(32).toString('hex')}`,
          status: 'active',
          repository_id: request.repository_id || repositories[0].id,
          allowed_roots: '/',
          tags: '',
          ip: request.ip || '127.0.0.1',
          last_seen_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        },
        ...clients,
      ]
      return send(res, 200, { ok: true, client_id: clientId })
    }
    request.status = 'rejected'
    return send(res, 200, { ok: true })
  }

  // 存储库
  if (p === '/api/repositories') {
    if (method === 'GET') return send(res, 200, repositories)
    if (method === 'POST') {
      const body = await readBody(req)
      const repo = {
        id: randomId('r', 12),
        name: body.name || 'new-repo',
        type: body.type || 'local',
        config: body.config || {},
        mountpoint: body.config?.path || `/mnt/${body.name || 'new-repo'}`,
        rest_port: 8000 + repositories.length + 1,
        status: 'active',
        total_bytes: 1024 ** 4,
        free_bytes: 700 * 1024 ** 3,
        created_at: new Date().toISOString(),
        last_checked_at: new Date().toISOString(),
      }
      repositories = [...repositories, repo]
      return send(res, 201, repo)
    }
  }

  match = p.match(/^\/api\/repositories\/([^/]+)$/)
  if (match) {
    const repo = repositories.find((item) => item.id === decodeURIComponent(match[1]))
    if (!repo) return fail(res, 404, 'not_found', '存储库不存在')
    if (method === 'PATCH') {
      const body = await readBody(req)
      if (body.name) repo.name = body.name
      if (body.config) repo.config = body.config
      return send(res, 200, repo)
    }
    if (method === 'DELETE') {
      if (clients.some((client) => client.repository_id === repo.id)) {
        return fail(res, 409, 'conflict', '仍有节点引用该存储库，无法删除')
      }
      repositories = repositories.filter((item) => item.id !== repo.id)
      return send(res, 200, { ok: true })
    }
  }

  match = p.match(/^\/api\/repositories\/([^/]+)\/validate$/)
  if (match && method === 'POST') {
    return send(res, 200, { ok: true, checked_at: new Date().toISOString(), detail: '写测试成功；restic check --read-data-subset=1% 通过（mock）' })
  }

  match = p.match(/^\/api\/repositories\/([^/]+)\/usage$/)
  if (match && method === 'GET') {
    const repo = repositories.find((item) => item.id === decodeURIComponent(match[1]))
    if (!repo) return fail(res, 404, 'not_found', '存储库不存在')
    return send(res, 200, {
      total: repo.total_bytes,
      free: repo.free_bytes,
      repo_bytes: repo.total_bytes - repo.free_bytes,
      clients: clients
        .filter((client) => client.repository_id === repo.id)
        .map((client, index) => ({
          client_id: client.id,
          bytes: (index + 1) * 42 * 1024 ** 3,
          snapshots: 12 + index * 7,
          last_backup: isoAgo((index + 1) * 5 * 3600 * 1000),
        })),
    })
  }

  // 备份计划
  if (p === '/api/plans') {
    if (method === 'GET') {
      const clientId = url.searchParams.get('client_id')
      return send(res, 200, clientId ? plans.filter((plan) => plan.client_id === clientId) : plans)
    }
    if (method === 'POST') {
      const body = await readBody(req)
      const plan = {
        id: randomId('p', 12),
        ...body,
        paths: body.paths || [],
        excludes: body.excludes || [],
        retention: body.retention || {},
        window: body.window || {},
        hooks: body.hooks || {},
        created_at: new Date().toISOString(),
        last_run_at: null,
        next_run_at: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
      }
      plans = [...plans, plan]
      return send(res, 201, plan)
    }
  }

  match = p.match(/^\/api\/plans\/([^/]+)$/)
  if (match) {
    const plan = plans.find((item) => item.id === decodeURIComponent(match[1]))
    if (!plan) return fail(res, 404, 'not_found', '计划不存在')
    if (method === 'PATCH') {
      const body = await readBody(req)
      Object.assign(plan, body)
      return send(res, 200, plan)
    }
    if (method === 'DELETE') {
      plans = plans.filter((item) => item.id !== plan.id)
      return send(res, 200, { ok: true })
    }
  }

  match = p.match(/^\/api\/plans\/([^/]+)\/(run|enable|disable)$/)
  if (match && method === 'POST') {
    const plan = plans.find((item) => item.id === decodeURIComponent(match[1]))
    if (!plan) return fail(res, 404, 'not_found', '计划不存在')
    if (match[2] === 'run') {
      const run = {
        id: randomId('run', 16),
        plan_id: plan.id,
        client_id: plan.client_id,
        repository_id: plan.repository_id,
        trigger: 'manual',
        status: 'queued',
        started_at: null,
        finished_at: null,
        snapshot_id: null,
        files_new: 0,
        files_changed: 0,
        files_unmodified: 0,
        bytes_added: 0,
        bytes_processed: 0,
        error: null,
        log_tail: '[INFO] 任务已排队',
        progress: null,
      }
      runs = [run, ...runs]
      plan.last_run_at = new Date().toISOString()
      return send(res, 200, { run })
    }
    plan.enabled = match[2] === 'enable' ? 1 : 0
    return send(res, 200, { ok: true, plan })
  }

  // 运行
  if (p === '/api/runs' && method === 'GET') {
    const clientId = url.searchParams.get('client_id')
    const status = url.searchParams.get('status')
    const limit = Math.min(100, Number(url.searchParams.get('limit')) || 20)
    const offset = Number(url.searchParams.get('offset')) || 0
    let list = runs
    if (clientId) list = list.filter((run) => run.client_id === clientId)
    if (status) list = list.filter((run) => run.status === status)
    return send(res, 200, { runs: list.slice(offset, offset + limit), total: list.length })
  }

  match = p.match(/^\/api\/runs\/([^/]+)$/)
  if (match && method === 'GET') {
    const run = runs.find((item) => item.id === decodeURIComponent(match[1]))
    if (!run) return fail(res, 404, 'not_found', '运行任务不存在')
    return send(res, 200, run)
  }

  match = p.match(/^\/api\/runs\/([^/]+)\/cancel$/)
  if (match && method === 'POST') {
    const run = runs.find((item) => item.id === decodeURIComponent(match[1]))
    if (!run) return fail(res, 404, 'not_found', '运行任务不存在')
    run.status = 'canceled'
    run.finished_at = new Date().toISOString()
    return send(res, 200, { ok: true, run })
  }

  match = p.match(/^\/api\/runs\/([^/]+)\/events$/)
  if (match && method === 'GET') {
    const run = runs.find((item) => item.id === decodeURIComponent(match[1]))
    if (!run) return fail(res, 404, 'not_found', '运行任务不存在')
    return streamEvents(req, res, 'run', run)
  }

  // 快照
  match = p.match(/^\/api\/snapshots\/([^/]+)\/([^/]+)\/ls$/)
  if (match && method === 'GET') {
    const path = pathOf(url)
    return send(res, 200, { path, entries: entriesFor(path) })
  }

  match = p.match(/^\/api\/snapshots\/([^/]+)\/([^/]+)\/search$/)
  if (match && method === 'GET') {
    const q = (url.searchParams.get('q') || '').toLowerCase()
    const results = []
    for (const [dir, entries] of Object.entries(FS)) {
      for (const entry of entries) {
        if (String(entry.name).toLowerCase().includes(q)) results.push(entry)
      }
    }
    return send(res, 200, { results })
  }

  match = p.match(/^\/api\/snapshots\/([^/]+)\/([^/]+)\/download$/)
  if (match && method === 'GET') {
    const path = pathOf(url)
    const filename = path === '/' ? 'snapshot-root.zip' : path.split('/').filter(Boolean).pop()
    const isDir = Array.isArray(FS[path])
    res.statusCode = 200
    res.setHeader('Content-Type', isDir ? 'application/zip' : 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
    res.end(isDir ? 'mock zip content（开发环境占位）' : `mock file content for ${path}\n`)
    return
  }

  match = p.match(/^\/api\/snapshots\/([^/]+)\/([^/]+)\/restore$/)
  if (match && method === 'POST') {
    const body = await readBody(req)
    const restore = {
      id: randomId('rst', 16),
      client_id: decodeURIComponent(match[1]),
      repository_id: repositories[0].id,
      snapshot_id: decodeURIComponent(match[2]),
      includes_json: JSON.stringify(body.includes || []),
      includes: body.includes || [],
      target: body.target || '/',
      overwrite: body.overwrite || 'if-changed',
      dry_run: body.dry_run ? 1 : 0,
      status: 'queued',
      created_by: mockUser.username,
      created_at: new Date().toISOString(),
      finished_at: null,
      error: null,
      log_tail: '[INFO] 恢复任务已排队',
    }
    restores = [restore, ...restores]
    return send(res, 201, { restore })
  }

  match = p.match(/^\/api\/snapshots\/([^/]+)\/([^/]+)\/pin$/)
  if (match && method === 'POST') {
    const body = await readBody(req)
    return send(res, 200, { ok: true, pinned: !!body.pinned })
  }

  match = p.match(/^\/api\/snapshots\/([^/]+)\/([^/]+)$/)
  if (match && method === 'DELETE') {
    return send(res, 200, { ok: true })
  }

  // 恢复任务
  if (p === '/api/restores' && method === 'GET') {
    const status = url.searchParams.get('status')
    const list = status ? restores.filter((item) => item.status === status) : restores
    return send(res, 200, { restores: list, total: list.length })
  }

  match = p.match(/^\/api\/restores\/([^/]+)$/)
  if (match && method === 'GET') {
    const restore = restores.find((item) => item.id === decodeURIComponent(match[1]))
    if (!restore) return fail(res, 404, 'not_found', '恢复任务不存在')
    return send(res, 200, restore)
  }

  match = p.match(/^\/api\/restores\/([^/]+)\/cancel$/)
  if (match && method === 'POST') {
    const restore = restores.find((item) => item.id === decodeURIComponent(match[1]))
    if (!restore) return fail(res, 404, 'not_found', '恢复任务不存在')
    restore.status = 'canceled'
    restore.finished_at = new Date().toISOString()
    return send(res, 200, { ok: true, restore })
  }

  match = p.match(/^\/api\/restores\/([^/]+)\/events$/)
  if (match && method === 'GET') {
    const restore = restores.find((item) => item.id === decodeURIComponent(match[1]))
    if (!restore) return fail(res, 404, 'not_found', '恢复任务不存在')
    return streamEvents(req, res, 'restore', restore)
  }

  // 用户
  if (p === '/api/users') {
    if (method === 'GET') return send(res, 200, users)
    if (method === 'POST') {
      const body = await readBody(req)
      if (users.some((user) => user.username === body.username)) {
        return fail(res, 409, 'conflict', '用户名已存在')
      }
      const user = {
        id: randomId('u', 12),
        username: body.username,
        display_name: body.display_name || body.username,
        email: body.email || '',
        role: body.role || 'viewer',
        source: body.source || 'local',
        enabled: body.enabled === false ? 0 : 1,
        created_at: new Date().toISOString(),
        last_login_at: null,
      }
      users = [...users, user]
      return send(res, 201, user)
    }
  }

  match = p.match(/^\/api\/users\/([^/]+)$/)
  if (match) {
    const user = users.find((item) => item.id === decodeURIComponent(match[1]))
    if (!user) return fail(res, 404, 'not_found', '用户不存在')
    if (method === 'PATCH') {
      const body = await readBody(req)
      const { password, ...rest } = body
      Object.assign(user, rest)
      if (password) user.password_reset_at = new Date().toISOString()
      return send(res, 200, user)
    }
    if (method === 'DELETE') {
      users = users.filter((item) => item.id !== user.id)
      return send(res, 200, { ok: true })
    }
  }

  // 审计
  if (p === '/api/audit' && method === 'GET') {
    const actor = url.searchParams.get('actor')
    const action = url.searchParams.get('action')
    const limit = Math.min(100, Number(url.searchParams.get('limit')) || 20)
    const offset = Number(url.searchParams.get('offset')) || 0
    let list = auditLog
    if (actor) list = list.filter((item) => item.actor.includes(actor))
    if (action) list = list.filter((item) => item.action.includes(action))
    return send(res, 200, { items: list.slice(offset, offset + limit), total: list.length })
  }

  // 设置
  if (p === '/api/settings/alerts') {
    if (method === 'GET') return send(res, 200, alertsSettings)
    if (method === 'PUT') {
      const body = await readBody(req)
      alertsSettings = { ...alertsSettings, ...body }
      return send(res, 200, { ok: true, alerts: alertsSettings })
    }
  }

  if (p === '/api/settings/alerts/test' && method === 'POST') {
    const body = await readBody(req)
    return send(res, 200, { ok: true, channel: body.channel || 'all', message: 'mock 测试告警已发送', at: new Date().toISOString() })
  }

  if (p === '/api/settings/general' && method === 'GET') {
    return send(res, 200, generalSettings)
  }

  if (p === '/api/metrics' && method === 'GET') {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.end('# HELP backup_center_up 服务是否在线\nbackup_center_up 1\n')
    return
  }

  return fail(res, 404, 'not_found', `mock 未实现接口：${method} ${p}`)
}

export function devMockPlugin() {
  return {
    name: 'backup-center-dev-mock',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        let url
        try {
          url = new URL(req.url, 'http://mock.local')
        } catch {
          return next()
        }
        const isApi = url.pathname.startsWith('/api/')
        const isExtra = ['/healthz', '/auth/oidc/start'].includes(url.pathname)
        if (!isApi && !isExtra) return next()

        handle(req, res, url).catch((error) => {
          if (!res.headersSent) {
            fail(res, 500, 'internal', error?.message || 'mock 内部错误')
          } else {
            res.end()
          }
        })
      })
    },
  }
}
