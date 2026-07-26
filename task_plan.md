# AINX Lambda Implementation Plan

## Goal

根据 `docs/ainx-lambda-plan.md` 和 `docs/auth-architecture.md` 两份规划文档，重构/创建 ainx-lambda 项目中的所有规划内容。

## Current State

- ✅ agent-registration (POST /agents/register)
- ✅ auth (DID Token Authorizer - 将被重构)
- ✅ agent-rotate-key (POST /agents/rotate-key)

## Planned Components

### New Lambda Functions (6个)

1. **auth-challenge** - Challenge生成服务 (POST /auth/challenge)
2. **auth-token** - Token签发服务 (POST /auth/token)
3. **auth-refresh** - Token刷新服务 (POST /auth/refresh)
4. **auth-revoke** - Token撤销服务 (POST /auth/revoke)
5. **jwt-authorizer** - JWT认证器 (API Gateway Authorizer)
6. **agent-revoke** - Agent注销服务 (DELETE /agents/{did})

### New DynamoDB Tables (3个)

1. **ainx-challenge-{stage}** - Challenge存储
2. **ainx-refresh-token-{stage}** - Refresh Token存储
3. **ainx-token-blacklist-{stage}** - Token黑名单

### Infrastructure Updates

- API Gateway 新路由配置
- Lambda 函数定义
- IAM 权限配置
- CloudWatch 告警

## Implementation Order

1. Phase 1: Create planning files
2. Phase 2-7: Implement each Lambda function with tests
3. Phase 8: Update infrastructure template
4. Phase 9: Update CI/CD workflow
5. Phase 10: Code quality checks
6. Phase 11: Run all tests

## Technical Decisions

- JWT算法: RS256 (非对称加密)
- JWT密钥管理: AWS Secrets Manager
- Challenge/Token存储: DynamoDB with TTL
- 测试框架: Jest (保持与现有项目一致)
- 构建工具: esbuild (保持与现有项目一致)

## Files to Create/Modify

### New Files

- functions/auth-challenge/src/index.ts
- functions/auth-challenge/package.json
- functions/auth-challenge/tsconfig.json
- functions/auth-challenge/**tests**/unit.test.ts
- functions/auth-challenge/**tests**/integration.test.ts
- functions/auth-challenge/**tests**/e2e.test.ts
- (类似结构 for auth-token, auth-refresh, auth-revoke, jwt-authorizer, agent-revoke)

### Modified Files

- infra/templates/template.yaml
- .github/workflows/ci-cd.yml
- package.json (workspaces)
- jest.config.js (如果需要)

## Risk Assessment

- **High**: JWT密钥管理复杂度
- **Medium**: 新旧认证系统切换
- **Low**: DynamoDB表结构设计

## Success Criteria

- [ ] 所有6个新Lambda函数实现完成
- [ ] 每个函数包含Unit/Integration/E2E测试
- [ ] 测试覆盖率 > 80%
- [ ] lint/format/tsc 全部通过
- [ ] 基础设施模板更新完成
- [ ] CI/CD流程更新完成
