# agent-direct-messaging - Work Plan

## TL;DR (For humans)

**What you'll get:** AI agent 之间的一对一直接消息传递功能。发送者通过 REST API 发送消息到指定连接，接收者通过 WebSocket 实时收到推送，也可以通过 REST API 查询某个连接的历史消息。

**Why this approach:** 复用现有的 Lambda + DynamoDB + API Gateway 架构，保持一致性。WebSocket 用于实时推送，REST API 用于可靠发送和查询，两者互补。采用 `/connections/{id}/messages` 路径设计，符合 RESTful 子资源语义，为未来群聊 `/groups/{id}/messages` 预留一致的模式。

**What it will NOT do:** 不支持群聊（路径预留但不实现），不支持消息已读标记，不支持未读消息筛选，不支持文件传输或消息加密。

**Effort:** Medium
**Risk:** Low - 基于成熟模式，复用现有基础设施
**Decisions to sanity-check:**
1. 消息表设计: receiverDid + timestamp 是否满足查询需求？
2. WebSocket 连接管理: DynamoDB 存储 connectionId 映射是否可扩展？
3. API 路径: `/connections/{id}/messages` 是否符合 RESTful 最佳实践？

Your next move: approve 开始执行，或 run a high-accuracy review first?

---

> TL;DR (machine): Medium effort, Low risk - Add direct messaging (REST + WebSocket) with DynamoDB storage using /connections/{id}/messages path, 15 todos across 6 waves

## Scope
### Must have
- 一对一消息发送 (POST /connections/{connectionId}/messages)
- 消息历史查询 (GET /connections/{connectionId}/messages)
- WebSocket 实时推送
- 仅已连接 agent 可发送
- 完整测试覆盖 (unit + integration + e2e)

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 群聊实现 (路径预留 /groups/{id}/messages 但不实现)
- 消息已读标记 API
- 未读消息筛选
- 文件/图片传输
- 消息加密
- 消息搜索
- 消息删除/编辑
- 离线消息持久化 (超出 TTL)

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: tests-after + Jest (与现有项目一致)
- Evidence: .omo/evidence/task-<N>-agent-direct-messaging.<ext>
- 每个 Lambda 必须有单元测试 (functions/*/\_\_tests\__/unit.test.ts)
- 必须有集成测试 (\_\_tests\__/message-integration.test.ts)
- 必须有 e2e 测试 (\_\_tests\__/message-e2e.test.ts)
- 所有测试必须通过: npm test
- 代码质量检查: npm run lint, npm run format:check, npx tsc --noEmit

## Execution strategy
### 前提条件
1. **创建 feature branch**: 从 main 分支创建 `feature/agent-direct-messaging`
   ```bash
   git checkout main
   git pull origin main
   git checkout -b feature/agent-direct-messaging
   ```
2. **AWS CLI 已配置**: 本地 AWS CLI 已完成登录，可直接使用
3. **部署方式**: 使用 AWS CLI 直接创建/更新资源，不使用 SAM 模板部署

### 部署策略
**基础设施部署顺序** (使用 AWS CLI):
1. 创建 DynamoDB 表 (Messages, WebSocketConnections)
2. 创建 WebSocket API Gateway
3. 创建 Lambda 函数 (connection-message-send, connection-message-list, websocket-connect, websocket-disconnect, websocket-push)
4. 配置 API Gateway 路由 (REST + WebSocket)
5. 配置 Lambda 权限和触发器

### 并行执行 waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.

**Wave 1: 基础设施与共享类型** - 无依赖，可立即开始
**Wave 2: DynamoDB 表创建** - 依赖 Wave 1
**Wave 3: Lambda 函数实现** - 依赖 Wave 2，内部可并行
**Wave 4: WebSocket API Gateway 创建** - 依赖 Wave 3
**Wave 5: 集成与测试** - 依赖 Wave 4
**Wave 6: 验证与清理** - 依赖 Wave 5

执行策略：
1. 按 wave 顺序执行，每个 wave 内部尽可能并行
2. Wave 3 的 Lambda 可并行实现
3. 每个 todo 完成后立即提交，保持 commit 粒度
4. 遇到阻塞时及时上报，不等待

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | none | 2, 3 | none |
| 2 | 1 | 4, 5, 6, 7, 8 | none |
| 3 | 1 | 4, 5, 6, 7, 8 | 2 |
| 4 | 2, 3 | 9, 10, 11 | 5, 6, 7, 8 |
| 5 | 2, 3 | 9, 10, 11 | 4, 6, 7, 8 |
| 6 | 2, 3 | 9, 10, 11 | 4, 5, 7, 8 |
| 7 | 2, 3 | 9, 10, 11 | 4, 5, 6, 8 |
| 8 | 2, 3 | 9, 10, 11 | 4, 5, 6, 7 |
| 9 | 4, 5, 6, 7, 8 | 12, 13 | none |
| 10 | 9 | 12, 13 | none |
| 11 | 9 | 12, 13 | 10 |
| 12 | 10, 11 | 13 | none |
| 13 | 12 | 14, 15 | none |
| 14 | 13 | 15 | none |
| 15 | 14 | none | none |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->

### Wave 1: 基础设施与共享类型
- [ ] 1. 创建 feature branch 并扩展 connection-utils 包
  What to do / Must NOT do: 
  1. 从 main 分支创建 feature branch: `git checkout main && git pull && git checkout -b feature/agent-direct-messaging`
  2. 在 packages/connection-utils/src/index.ts 添加 Message 接口、MessageType 枚举、消息验证函数
  3. 运行 `npm run build` 验证编译
  Must NOT 修改现有连接相关类型。
  Parallelization: Wave 1 | Blocked by: none | Blocks: 2, 3
  References: packages/connection-utils/src/index.ts:1-185, packages/shared-utils/index.ts:1-54
  Acceptance criteria: 1) feature branch 创建成功 2) `npm run build` 在 connection-utils 成功 3) 导出 Message, MessageType, isValidMessageContent 等新类型/函数
  QA scenarios: happy: 导入新类型无编译错误; failure: 类型不匹配时编译失败
  Commit: Y | feat(connection-utils): add message types and validation functions

### Wave 2: DynamoDB 表创建 (使用 AWS CLI)
- [ ] 2. 使用 AWS CLI 创建 Messages DynamoDB 表
  What to do / Must NOT do: 
  1. 运行 AWS CLI 命令创建 Messages 表:
     ```bash
     aws dynamodb create-table \
       --table-name ainx-messages-dev \
       --attribute-definitions AttributeName=receiverDid,AttributeType=S AttributeName=timestamp,AttributeType=S \
       --key-schema AttributeName=receiverDid,KeyType=HASH AttributeName=timestamp,KeyType=RANGE \
       --billing-mode PAY_PER_REQUEST
     ```
  2. 验证表创建成功
  Must NOT 使用 SAM 模板创建表。
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 4, 5, 6, 7, 8
  References: AWS DynamoDB CLI 文档, 现有表命名模式 (ainx-*-${Stage})
  Acceptance criteria: 1) 表创建成功 2) 表结构正确 (receiverDid HASH, timestamp RANGE) 3) 表状态为 ACTIVE
  QA scenarios: happy: aws dynamodb describe-table 返回 ACTIVE; failure: 表已存在时处理
  Commit: Y | feat(infra): create Messages DynamoDB table via AWS CLI

- [ ] 3. 使用 AWS CLI 创建 WebSocketConnections DynamoDB 表
  What to do / Must NOT do: 
  1. 运行 AWS CLI 命令创建 WebSocketConnections 表:
     ```bash
     aws dynamodb create-table \
       --table-name ainx-websocket-connections-dev \
       --attribute-definitions AttributeName=connectionId,AttributeType=S \
       --key-schema AttributeName=connectionId,KeyType=HASH \
       --billing-mode PAY_PER_REQUEST
     ```
  2. 验证表创建成功
  Must NOT 使用 SAM 模板创建表。
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 4, 5, 6, 7, 8
  References: AWS DynamoDB CLI 文档
  Acceptance criteria: 1) 表创建成功 2) 表结构正确 (connectionId HASH) 3) 表状态为 ACTIVE
  QA scenarios: happy: aws dynamodb describe-table 返回 ACTIVE; failure: 表已存在时处理
  Commit: Y | feat(infra): create WebSocketConnections DynamoDB table via AWS CLI

### Wave 3: Lambda 函数实现
- [ ] 4. 实现 connection-message-send Lambda (POST /connections/{connectionId}/messages)
  What to do / Must NOT do: 
  1. 创建 functions/connection-message-send/ 目录结构:
     - src/index.ts (主逻辑)
     - \__tests\__/unit.test.ts (单元测试)
     - package.json
     - tsconfig.json
  2. 实现发送消息逻辑：
     - 从路径提取 connectionId
     - 验证发送者/接收者已连接 (查询 Connections 表)
     - 验证发送者属于该连接
     - 写入 DynamoDB Messages 表
     - 调用 WebSocket 推送
  3. Response 仅返回发送状态:
     ```json
     { "success": true, "messageId": "msg_abc123" }
     ```
  4. 实现幂等性 (使用 messageIdempotencyKey)
  Must NOT 实现群聊逻辑。
  Parallelization: Wave 3 | Blocked by: 2, 3 | Blocks: 9, 10, 11
  References: functions/connection-send-request/src/index.ts:1-243 (类似模式), functions/connection-list-connections/src/index.ts:1-95 (查询连接模式)
  Acceptance criteria: 1) 单元测试通过 2) 验证仅允许已连接 agent 发送 3) 消息正确写入 DynamoDB 4) 路径参数正确解析 5) Response 简洁 6) 幂等性处理
  QA scenarios: happy: 发送消息成功返回 201; failure: 未连接 agent 返回 403，无效 connectionId 返回 400，重复发送返回 200
  Commit: Y | feat(connection-message-send): implement direct message sending

- [ ] 5. 实现 connection-message-list Lambda (GET /connections/{connectionId}/messages)
  What to do / Must NOT do: 
  1. 创建 functions/connection-message-list/ 目录结构:
     - src/index.ts (主逻辑)
     - \__tests\__/unit.test.ts (单元测试)
     - package.json
     - tsconfig.json
  2. 实现查询逻辑：
     - 从路径提取 connectionId
     - 验证用户属于该连接 (查询 Connections 表)
     - 查询两个方向的消息 (senderDid 和 receiverDid)
     - 支持分页 (使用 nextToken)
     - 倒序排列 (最新消息在前)
  3. Response 仅返回必要信息:
     ```json
     {
       "messages": [
         {
           "messageId": "msg_abc123",
           "senderDid": "did:key:abc...",
           "content": "Hello",
           "timestamp": "2024-01-15T10:30:00Z"
         }
       ],
       "nextToken": "eyJ0..."
     }
     ```
  Must NOT 实现未读消息筛选。
  Parallelization: Wave 3 | Blocked by: 2, 3 | Blocks: 9, 10, 11
  References: functions/connection-list-connections/src/index.ts:1-95 (查询模式), functions/connection-accept-request/src/index.ts:1-177 (连接验证模式)
  Acceptance criteria: 1) 单元测试通过 2) 正确返回双向消息 3) 支持分页 4) 验证用户属于该连接 5) Response 简洁
  QA scenarios: happy: 查询返回消息列表; failure: 无效 connectionId 返回 400，无权限返回 403
  Commit: Y | feat(connection-message-list): implement message history query

- [ ] 6. 实现 websocket-connect Lambda ($connect)
  What to do / Must NOT do: 
  1. 创建 functions/websocket-connect/ 目录结构:
     - src/index.ts (主逻辑)
     - \__tests\__/unit.test.ts (单元测试)
     - package.json
     - tsconfig.json
  2. 实现连接逻辑：
     - 从 query string 获取 token
     - 验证 JWT (复用 jwt-authorizer 逻辑)
     - 存储 connectionId -> did 映射到 DynamoDB
  3. 返回连接成功响应
  Must NOT 处理消息发送。
  Parallelization: Wave 3 | Blocked by: 2, 3 | Blocks: 9, 10, 11
  References: functions/jwt-authorizer/src/index.ts:1-141 (JWT 验证模式)
  Acceptance criteria: 1) 单元测试通过 2) 正确存储连接映射 3) 无效 token 拒绝连接
  QA scenarios: happy: 有效 token 连接成功; failure: 无效 token 返回 401
  Commit: Y | feat(websocket-connect): implement WebSocket connect handler

- [ ] 7. 实现 websocket-disconnect Lambda ($disconnect)
  What to do / Must NOT do: 
  1. 创建 functions/websocket-disconnect/ 目录结构:
     - src/index.ts (主逻辑)
     - \__tests\__/unit.test.ts (单元测试)
     - package.json
     - tsconfig.json
  2. 实现断开逻辑：
     - 从 event 获取 connectionId
     - 从 DynamoDB 删除 connectionId -> did 映射
  3. 静默处理连接不存在的情况
  Must NOT 处理其他逻辑。
  Parallelization: Wave 3 | Blocked by: 2, 3 | Blocks: 9, 10, 11
  References: functions/connection-remove-connection/src/index.ts:1-132 (删除模式)
  Acceptance criteria: 1) 单元测试通过 2) 正确删除连接映射 3) 处理连接不存在的情况（静默处理）
  QA scenarios: happy: 断开连接成功; failure: 连接不存在时静默处理
  Commit: Y | feat(websocket-disconnect): implement WebSocket disconnect handler

- [ ] 8. 实现 websocket-push Lambda (发送消息时触发)
  What to do / Must NOT do: 
  1. 创建 functions/websocket-push/ 目录结构:
     - src/index.ts (主逻辑)
     - \__tests\__/unit.test.ts (单元测试)
     - package.json
     - tsconfig.json
  2. 实现推送逻辑：
     - 接收消息事件 (包含 receiverDid, content)
     - 查询 DynamoDB WebSocketConnections 表
     - 使用 API Gateway Management API 推送消息
     - 处理 GoneException (删除 stale 连接)
  3. 静默处理接收者不在线的情况
  Must NOT 处理消息存储。
  Parallelization: Wave 3 | Blocked by: 2, 3 | Blocks: 9, 10, 11
  References: AWS API Gateway Management API 文档 (https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-how-to-call-websocket-api.html)
  Acceptance criteria: 1) 单元测试通过 2) 正确推送消息到接收者 3) 处理接收者不在线情况 4) 处理连接不存在情况
  QA scenarios: happy: 消息成功推送; failure: 接收者不在线时静默处理，连接不存在时删除映射
  Commit: Y | feat(websocket-push): implement message push via WebSocket

### Wave 4: WebSocket API Gateway 创建 (使用 AWS CLI)
- [ ] 9. 使用 AWS CLI 创建 WebSocket API Gateway
  What to do / Must NOT do: 
  1. 创建 WebSocket API:
     ```bash
     aws apigatewayv2 create-api \
       --name ainx-websocket-api \
       --protocol-type WEBSOCKET \
       --route-selection-expression '$request.body.action'
     ```
  2. 创建路由:
     - $connect (集成 websocket-connect Lambda)
     - $disconnect (集成 websocket-disconnect Lambda)
     - sendMessage (集成 websocket-push Lambda)
  3. 创建部署和阶段
  4. 获取 WebSocket 端点 URL
  Must NOT 使用 SAM 模板创建。
  Parallelization: Wave 4 | Blocked by: 4, 5, 6, 7, 8 | Blocks: 12, 13
  References: AWS API Gateway V2 CLI 文档
  Acceptance criteria: 1) API Gateway 创建成功 2) 所有路由配置正确 3) Lambda 集成正确 4) 部署成功
  QA scenarios: happy: aws apigatewayv2 get-api 返回正确配置; failure: 路由配置错误时修复
  Commit: Y | feat(infra): create WebSocket API Gateway via AWS CLI

- [ ] 10. 使用 AWS CLI 配置 REST API Gateway 路由
  What to do / Must NOT do: 
  1. 在现有 REST API Gateway 上创建资源:
     - /connections/{connectionId}/messages
  2. 创建方法:
     - POST (集成 connection-message-send Lambda)
     - GET (集成 connection-message-list Lambda)
  3. 配置请求验证和授权 (使用现有 DIDAuthorizer)
  4. 部署 API
  Must NOT 修改现有路由。
  Parallelization: Wave 4 | Blocked by: 9 | Blocks: 12, 13
  References: AWS API Gateway CLI 文档, 现有 API Gateway ID
  Acceptance criteria: 1) 资源和方法创建成功 2) Lambda 集成正确 3) 授权配置正确 4) 部署成功
  QA scenarios: happy: API 端点返回正确响应; failure: 集成错误时修复
  Commit: Y | feat(infra): configure REST API Gateway routes via AWS CLI

- [ ] 11. 使用 AWS CLI 配置 Lambda 权限和触发器
  What to do / Must NOT do: 
  1. 为每个 Lambda 添加 API Gateway 触发权限:
     ```bash
     aws lambda add-permission \
       --function-name connection-message-send \
       --statement-id apigateway-invoke \
       --action lambda:InvokeFunction \
       --principal apigateway.amazonaws.com \
       --source-arn "arn:aws:execute-api:*:*:*"
     ```
  2. 配置 Lambda 环境变量 (表名、WebSocket 端点等)
  3. 配置 Lambda 执行角色权限 (DynamoDB 访问)
  Must NOT 修改现有 Lambda 权限。
  Parallelization: Wave 4 | Blocked by: 9 | Blocks: 12, 13
  References: AWS Lambda CLI 文档
  Acceptance criteria: 1) 权限配置成功 2) Lambda 可被 API Gateway 调用 3) Lambda 可访问 DynamoDB
  QA scenarios: happy: Lambda 调用成功; failure: 权限不足时修复
  Commit: Y | feat(infra): configure Lambda permissions and triggers via AWS CLI

### Wave 5: 集成与测试
- [ ] 12. 编写集成测试 (message-integration.test.ts)
  What to do / Must NOT do: 
  1. 创建 \__tests\__/message-integration.test.ts
  2. 测试场景:
     - 发送消息成功
     - 发送消息到未连接 agent 失败
     - 查询消息历史
     - 分页查询
     - 重复发送（幂等性）
  3. 使用 mock DynamoDB 和 mock WebSocket
  Must NOT 测试 e2e 场景。
  Parallelization: Wave 5 | Blocked by: 10, 11 | Blocks: 13
  References: \__tests\__/connection-integration.test.ts (集成测试模式)
  Acceptance criteria: 1) 所有集成测试通过 2) 覆盖成功和失败场景 3) 覆盖分页场景 4) 覆盖幂等性场景
  QA scenarios: happy: 完整消息流程测试通过; failure: 各种错误场景正确处理
  Commit: Y | test(integration): add message integration tests

- [ ] 13. 编写 e2e 测试 (message-e2e.test.ts)
  What to do / Must NOT do: 
  1. 创建 \__tests\__/message-e2e.test.ts
  2. 测试完整端到端流程:
     - 注册 agent
     - 建立连接
     - 发送消息 (REST API)
     - WebSocket 接收验证
  3. 注意：WebSocket 测试需要特殊处理（使用 wscat 或类似工具）
  Must NOT 测试性能。
  Parallelization: Wave 5 | Blocked by: 12 | Blocks: 14, 15
  References: \__tests\__/connection-e2e.test.ts (e2e 测试模式)
  Acceptance criteria: 1) 所有 e2e 测试通过 2) 覆盖完整用户流程 3) 覆盖 WebSocket 实时推送验证
  QA scenarios: happy: 完整端到端消息流程通过; failure: 各种边界情况处理
  Commit: Y | test(e2e): add message e2e tests

### Wave 6: 验证与清理
- [ ] 14. 运行全量测试并修复问题
  What to do / Must NOT do: 
  1. 运行 `npm run lint`
  2. 运行 `npm run format:check`
  3. 运行 `npx tsc --noEmit`
  4. 运行 `npm test`
  5. 修复所有问题
  Must NOT 修改现有测试。
  Parallelization: Wave 6 | Blocked by: 13 | Blocks: 15
  References: package.json:31-33 (测试脚本)
  Acceptance criteria: 1) lint 通过 2) format:check 通过 3) tsc --noEmit 通过 4) 所有测试通过
  QA scenarios: happy: 所有检查通过; failure: 任何检查失败时修复
  Commit: Y | chore(tests): fix lint and type issues

- [ ] 15. 创建 PR 并合并到 main 分支
  What to do / Must NOT do: 
  1. 推送 feature branch 到远程:
     ```bash
     git push origin feature/agent-direct-messaging
     ```
  2. 创建 Pull Request:
     - 标题: feat: add agent direct messaging support
     - 描述: 包含功能说明、API 文档、测试覆盖
     - 关联 Issue (如果有)
  3. 等待 CI/CD 通过
  4. 合并到 main 分支
  Must NOT 直接推送到 main。
  Parallelization: Wave 6 | Blocked by: 14 | Blocks: none
  References: GitHub PR 流程
  Acceptance criteria: 1) PR 创建成功 2) CI/CD 通过 3) 代码审查通过 4) 成功合并到 main
  QA scenarios: happy: PR 合并成功; failure: CI 失败时修复
  Commit: N | chore(merge): merge feature branch to main

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [ ] F1. Plan compliance audit: 验证所有 todo 已完成，API 符合设计
- [ ] F2. Code quality review: lint, format, tsc 全通过
- [ ] F3. Real manual QA: 部署到 SIT 环境，手动测试消息发送和接收
- [ ] F4. Scope fidelity: 确认未实现群聊、未读消息等超出范围的功能

## Commit strategy
- 每个 todo 完成后必须执行 git commit，使用 Conventional Commits 格式
- Commit 粒度：每个 todo 一个 commit
- Commit message 格式: `<type>(<scope>): <description>`
- 示例: `feat(connection-message-send): implement direct message sending`
- 禁止在 main 分支直接提交，所有工作必须在 feature branch 完成
- 最终通过 PR 合并到 main 分支

## Success criteria
1. POST /connections/{connectionId}/messages 成功发送消息并返回 201
2. GET /connections/{connectionId}/messages 正确返回消息历史
3. GET /connections/{connectionId}/messages 支持分页（使用 nextToken）
4. WebSocket 实时推送消息到接收者
5. 仅已连接的 agent 可以互相发送消息
6. 消息发送具有幂等性（防止重复发送）
7. 所有单元测试、集成测试、e2e 测试通过
8. lint, format:check, tsc --noEmit 全部通过
9. 所有 AWS 资源通过 AWS CLI 创建，不使用 SAM 模板
10. 所有代码通过 feature branch 开发，最终通过 PR 合并到 main