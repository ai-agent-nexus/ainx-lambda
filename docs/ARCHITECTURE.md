# 架构设计文档

## 概述

AINX Lambda 采用 monorepo 架构，基于全球最佳实践设计，支持多函数管理、共享代码复用和自动化部署。

## 架构图

```
┌─────────────────────────────────────────┐
│           GitHub Repository              │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  │
│  │ Functions│  │ Packages│  │  Infra  │  │
│  └────┬────┘  └────┬────┘  └────┬────┘  │
└───────┼────────────┼────────────┼───────┘
        │            │            │
        ▼            ▼            ▼
┌─────────────────────────────────────────┐
│         GitHub Actions CI/CD            │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  │
│  │  Lint   │  │  Test   │  │ Deploy  │  │
│  └─────────┘  └─────────┘  └─────────┘  │
└─────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────┐
│              AWS Cloud                   │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  │
│  │ Lambda  │  │API Gateway│  │CloudWatch│  │
│  │ Functions│  │         │  │         │  │
│  └─────────┘  └─────────┘  └─────────┘  │
└─────────────────────────────────────────
```

## 设计原则

### 1. 单一职责

每个 Lambda 函数只负责一个业务功能，保持简单和可测试。

### 2. 共享代码复用

通用逻辑（日志、工具函数）放在 `packages/` 目录，通过 NPM Workspaces 共享。

### 3. 基础设施即代码

使用 AWS SAM 定义所有基础设施，版本控制和代码审查。

### 4. 自动化优先

所有部署通过 CI/CD 自动化，减少人工干预和错误。

## 技术栈

| 技术           | 版本  | 用途                |
| -------------- | ----- | ------------------- |
| Node.js        | 24.x  | Lambda 运行时       |
| TypeScript     | 5.8+  | 开发语言            |
| esbuild        | 0.25+ | 构建工具            |
| Jest           | 29.7+ | 测试框架            |
| ts-jest        | 29.3+ | TypeScript 测试支持 |
| AWS SAM        | 最新  | 基础设施定义        |
| GitHub Actions | 最新  | CI/CD               |

## 技术选型理由

### NPM Workspaces vs Lerna vs Nx

- **NPM Workspaces**: 原生支持，零配置，适合中小型项目
- **Lerna**: 功能丰富但较重，适合大型项目
- **Nx**: 功能强大但学习曲线陡峭，适合企业级项目

选择 NPM Workspaces 是因为：

- 原生集成，无需额外工具
- 与 npm cli 无缝配合
- 足够满足当前需求

### esbuild vs webpack vs rollup

- **esbuild**: 极速构建，适合 Lambda 打包
- **webpack**: 功能丰富但较慢
- **rollup**: 适合库打包

选择 esbuild 是因为：

- 构建速度极快（比 webpack 快 10-100 倍）
- 原生 TypeScript 支持
- 输出体积小，适合 Lambda

### SAM vs Serverless Framework vs CDK

- **SAM**: AWS 官方，简单直接
- **Serverless Framework**: 跨云支持，插件生态
- **CDK**: 编程式定义，适合复杂架构

选择 SAM 是因为：

- AWS 原生支持
- 与 CloudFormation 集成
- 本地测试支持
- 学习曲线平缓

### Jest 测试策略

#### 测试层级

```
┌─────────────────────────────────────┐
│         Integration Tests           │
│    (Lambda Handler + API Gateway)   │
├─────────────────────────────────────┤
│          Unit Tests                 │
│    (Business Logic + Utilities)     │
├─────────────────────────────────────┤
│         Shared Package Tests        │
│    (Logger + Utils + Types)        │
└─────────────────────────────────────┘
```

#### 测试配置

- **单元测试**: `*.test.ts` - 测试单个函数或模块
- **集成测试**: `*.integration.test.ts` - 测试完整请求流程
- **覆盖率**: 目标 > 80%
- **CI 集成**: PR 时自动运行，失败则阻止合并

#### 测试工具

- **Jest**: 测试框架
- **ts-jest**: TypeScript 支持
- **jest.mock**: 模拟依赖
- **coverage**: 生成覆盖率报告

## 部署策略

### GitHub Flow 工作流

本项目采用 [GitHub Flow](https://docs.github.com/en/get-started/quickstart/github-flow)：

```
main (production-ready)
  │
  ├── feature/user-auth
  │     │
  │     └── PR → Code Review → Merge to main → Deploy
  │
  ├── feature/payment-gateway
  │     │
  │     └── PR → Code Review → Merge to main → Deploy
  │
  └── hotfix/security-patch
        │
        └── PR → Code Review → Merge to main → Deploy
```

### 环境隔离

- **dev**: 开发环境，本地测试
- **staging**: 预发布环境，手动触发
- **prod**: 生产环境，PR 合并后自动部署

### 按需部署

使用 GitHub Actions 的路径过滤功能，只部署变更的函数：

```yaml
- uses: dorny/paths-filter@v3
  id: filter
  with:
    filters: |
      functions:
        - 'functions/**'
```

### 回滚策略

- Lambda 版本控制
- 别名指向稳定版本
- 快速切换别名实现回滚

## 监控和告警

### 日志

- 结构化 JSON 日志
- 包含请求 ID、时间戳、上下文
- CloudWatch Logs 集中管理

### 指标

- Lambda 调用次数
- 错误率
- 持续时间
- 内存使用

### 告警

- 错误率 > 1%
- 持续时间 > 阈值
- 内存使用 > 80%

## 安全考虑

### 身份验证

- API Gateway API Keys
- Lambda Authorizers
- IAM Roles

### 数据保护

- 环境变量加密
- VPC 隔离（可选）
- 传输加密（HTTPS）

### 合规

- 最小权限原则
- 审计日志
- 数据保留策略

## 性能优化

### 冷启动优化

- 使用 Provisioned Concurrency（生产环境）
- 减少依赖包大小
- 使用 Lambda Layers

### 运行时优化

- 适当内存配置
- 超时设置
- 异步处理

## 扩展性

### 水平扩展

- Lambda 自动扩展
- API Gateway 限流
- DynamoDB 自动扩展

### 垂直扩展

- 增加内存和 CPU
- 优化代码性能
- 使用缓存

## 成本优化

### 资源优化

- 适当内存配置
- 超时设置
- 删除未使用资源

### 计费优化

- 使用 Reserved Concurrency
- 监控成本
- 设置预算告警

## 未来改进

- [ ] 添加 DynamoDB 集成
- [ ] 实现 SQS/SNS 事件驱动
- [ ] 添加 Step Functions 工作流
- [ ] 实现 Canary 部署
- [ ] 添加性能测试
- [ ] 实现多区域部署
