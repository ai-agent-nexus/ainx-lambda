---
slug: agent-direct-messaging
status: approved
intent: clear
pending-action: execution ready
approach: 添加消息存储表 + REST API (发送/获取消息) + WebSocket 推送 (通过 API Gateway WebSocket API)，使用 AWS CLI 创建资源，不使用 SAM 模板
---

# Draft: agent-direct-messaging

## Components (topology ledger)
| id | outcome | status | evidence path |
|---|---|---|---|
| C1 | DynamoDB Messages 表存储一对一消息 | active | AWS CLI create-table |
| C2 | DynamoDB WebSocketConnections 表存储连接映射 | active | AWS CLI create-table |
| C3 | REST API: POST /connections/{id}/messages 发送消息 | active | functions/connection-message-send/ |
| C4 | REST API: GET /connections/{id}/messages 获取消息 | active | functions/connection-message-list/ |
| C5 | WebSocket API Gateway + Lambda 推送 | active | AWS CLI create-api |
| C6 | REST API Gateway 路由配置 | active | AWS CLI create-resource/method |
| C7 | connection-utils 扩展消息类型 | active | packages/connection-utils/ |
| C8 | 单元测试 + 集成测试 + e2e 测试 | active | __tests__/ |

## Open assumptions (announced defaults)
| assumption | adopted default | rationale | reversible? |
|---|---|---|---|
| WebSocket 方案 | API Gateway WebSocket API + Lambda | AWS 原生方案，无需额外基础设施 | 可改为 IoT Core 或第三方 |
| 消息存储 | DynamoDB 单表，按 receiverDid + timestamp 排序 | 与现有架构一致，支持时间排序查询 | 可拆分为消息表 + 索引 |
| 消息格式 | JSON: {id, senderDid, receiverDid, content, timestamp, read} | 简单通用，支持扩展 | 是 |
| 推送触发 | 发送消息时同时写入 DynamoDB 和推送到 WebSocket | 实时性好 | 可改为轮询 |
| 认证方式 | 复用现有 JWT Authorizer | 统一认证体系 | 是 |
| API 路径设计 | /connections/{id}/messages 作为子资源 | 符合 RESTful 语义，与现有 /connections/* 一致 | 是 |
| 群聊扩展 | 预留 /groups/{id}/messages 路径模式 | 与一对一消息保持一致的子资源设计 | 是 |
| 部署方式 | 使用 AWS CLI 直接创建资源 | 用户明确要求不使用 SAM 模板 | 否 |
| 开发流程 | feature branch + PR 合并 | 用户明确要求 | 否 |

## Findings (cited - path:lines)
- 现有架构: API Gateway REST API + Lambda + DynamoDB (`infra/templates/template.yaml:54-1034`)
- 认证: JWT Authorizer (`infra/templates/template.yaml:305-340`)
- 连接系统: 已有一整套连接管理 (`functions/connection-*`)
- 共享工具: formatResponse, parseBody, validateInput (`packages/shared-utils/index.ts:1-54`)
- 日志: Logger 类 (`packages/logger/index.ts:1-48`)
- 测试: Jest + ts-jest (`package.json:31-33`)
- CI/CD: GitHub Actions (`.github/workflows/ci-cd.yml:1-100`)
- 无现有 WebSocket 支持 (grep 确认)
- AWS CLI 已配置完成 (用户确认)

## Decisions (with rationale)
1. **WebSocket 方案**: API Gateway WebSocket API
   - 理由: AWS 原生，与现有 Lambda 架构无缝集成，无需额外服务器
   - 替代方案: IoT Core (更复杂), 第三方服务 (增加依赖)

2. **消息表设计**: receiverDid (HASH) + timestamp (RANGE)
   - 理由: 支持按接收者查询，按时间排序，与现有表设计一致
   - 替代方案: senderDid 作为 HASH (不利于接收者查询)

3. **消息发送流程**: REST API 接收 -> Lambda 处理 -> DynamoDB 存储 + WebSocket 推送
   - 理由: REST API 更可靠（可重试），WebSocket 用于实时推送
   - 替代方案: 纯 WebSocket (连接不稳定时消息丢失)

4. **一对一限制**: 仅支持已连接的 agent 之间发送
   - 理由: 复用现有连接验证逻辑，防止垃圾消息
   - 替代方案: 允许任何人发送 (需要额外反垃圾机制)

5. **API 路径设计**: /connections/{id}/messages 作为子资源
   - 理由: 符合 RESTful 语义，消息是连接的子资源，与现有 /connections/* 路径风格一致
   - 替代方案: /messages/connection (扁平路径，语义不够清晰)

6. **群聊扩展**: 预留 /groups/{id}/messages 路径
   - 理由: 与一对一消息保持一致的子资源设计，未来群聊功能天然适配
   - 替代方案: /messages/group (扁平路径，与现有风格不一致)

7. **部署方式**: 使用 AWS CLI 直接创建资源
   - 理由: 用户明确要求不使用 SAM 模板
   - 替代方案: SAM 模板 (用户明确禁止)

8. **开发流程**: feature branch + PR 合并
   - 理由: 用户明确要求
   - 替代方案: 直接提交到 main (用户明确禁止)

## Scope IN
- 从 main 分支创建 feature branch
- DynamoDB Messages 表 (AWS CLI 创建)
- DynamoDB WebSocketConnections 表 (AWS CLI 创建)
- POST /connections/{connectionId}/messages (发送消息)
- GET /connections/{connectionId}/messages (获取某个连接的消息)
- WebSocket API Gateway (AWS CLI 创建)
- REST API Gateway 路由配置 (AWS CLI 配置)
- Lambda 函数 (connection-message-send, connection-message-list, websocket-connect, websocket-disconnect, websocket-push)
- Lambda 权限和触发器配置 (AWS CLI 配置)
- connection-utils 扩展 (消息类型、验证函数)
- 单元测试 (每个 Lambda)
- 集成测试 (DynamoDB 交互)
- e2e 测试 (完整流程)
- 创建 PR 合并到 main 分支

## Scope OUT (Must NOT have)
- SAM 模板部署 (用户明确禁止)
- 直接提交到 main 分支 (用户明确禁止)
- 群聊实现 (路径预留 /groups/{id}/messages 但不实现)
- 消息加密 (端到端)
- 消息删除/编辑
- 文件/图片传输
- 消息搜索
- 离线消息持久化 (超出 TTL)
- 已读回执 (双向)
- 消息反应/表情
- 消息已读标记 API

## Open questions
1. WebSocket 连接管理: 需要 DynamoDB 表存储 connectionId -> did 映射吗？
   - 默认: 是，需要 WebSocketConnections 表
   
2. 消息内容大小限制?
   - 默认: 10KB (API Gateway 限制)

3. 消息历史分页?
   - 默认: 支持，每页 20 条

4. AWS CLI 命令执行顺序?
   - 默认: 先创建表 -> 创建 Lambda -> 创建 API Gateway -> 配置路由 -> 配置权限

## Approval gate
status: approved

### Brief
基于现有 AINX Lambda 架构，添加 AI agent 一对一消息传递功能：

**核心功能:**
1. **REST API** 提供消息发送、获取消息历史
2. **WebSocket** 通过 API Gateway WebSocket API 实现实时推送
3. **DynamoDB** 存储消息，按接收者+时间排序

**API 设计 (已调整为子资源路径):**
- `POST /connections/{connectionId}/messages` - 发送消息到指定连接
- `GET /connections/{connectionId}/messages` - 获取某个连接的消息历史
- 预留 `POST /groups/{groupId}/messages` - 未来群聊扩展
- 预留 `GET /groups/{groupId}/messages` - 未来群聊扩展

**部署方式 (用户明确要求):**
- 使用 AWS CLI 直接创建所有资源
- 不使用 SAM 模板
- 本地 AWS CLI 已完成登录，可直接使用

**开发流程 (用户明确要求):**
1. 从 main 分支创建 feature branch: `feature/agent-direct-messaging`
2. 所有开发工作在 feature branch 完成
3. 每个步骤完成后执行 git commit
4. 完成所有内容后创建 PR 合并到 main 分支

**技术方案:**
- 复用现有 JWT 认证、DynamoDB 客户端、Logger、formatResponse 等基础设施
- 使用 AWS CLI 创建 DynamoDB 表 (Messages, WebSocketConnections)
- 使用 AWS CLI 创建 WebSocket API Gateway
- 使用 AWS CLI 配置 REST API Gateway 路由
- 新增 5 个 Lambda 函数: connection-message-send, connection-message-list, websocket-connect, websocket-disconnect, websocket-push
- 使用 AWS CLI 配置 Lambda 权限和触发器

**关键决策 (默认选项):**
1. WebSocket 连接管理: 使用 DynamoDB 表存储 connectionId -> did 映射 ✅
2. 消息内容限制: 10KB (API Gateway 限制) ✅
3. 消息历史分页: 每页 20 条 ✅
4. 仅支持已连接 agent: 复用现有连接验证 ✅
5. API 路径: /connections/{id}/messages 符合 RESTful 子资源语义 ✅
6. 群聊扩展: 预留 /groups/{id}/messages 保持一致的子资源设计 ✅
7. 部署方式: 使用 AWS CLI，不使用 SAM 模板 ✅
8. 开发流程: feature branch + PR 合并 ✅

**工作量:** Medium (15 todos，分 6 个 wave)
**风险:** Low (基于成熟模式，复用现有基础设施)

**用户反馈已采纳:**
1. ✅ 移除 GET /messages/unread API
2. ✅ 移除 PUT /messages/{id}/read API
3. ✅ 采用 /connections/{id}/messages 子资源路径
4. ✅ 预留 /groups/{id}/messages 群聊扩展路径
5. ✅ 使用 AWS CLI 创建资源，不使用 SAM 模板
6. ✅ 从 main 创建 feature branch，完成后 PR 合并
7. ✅ 每个步骤完成后执行 git commit