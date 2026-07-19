# AINX Lambda Monorepo

基于全球最佳实践的 AWS Lambda monorepo 架构，支持 TypeScript、NPM Workspaces、SAM 和 GitHub Actions CI/CD。

## 目录结构

```
ainx-lambda/
├── functions/              # Lambda 函数目录
│   └── hello-world/        # 示例函数：Hello World
├── packages/               # 共享代码包
│   ├── logger/             # 日志工具
│   └── shared-utils/       # 通用工具函数
├── infra/                  # 基础设施代码
│   ├── scripts/            # 部署和开发脚本
│   └── templates/          # SAM/CloudFormation 模板
├── .github/workflows/        # GitHub Actions CI/CD
├── docs/                   # 文档
├── package.json            # 根配置（NPM Workspaces）
├── tsconfig.json           # TypeScript 配置
└── README.md               # 本文件
```

## 技术栈

- **运行时**: Node.js 24.x
- **语言**: TypeScript 5.8+
- **构建工具**: esbuild
- **测试框架**: Jest + ts-jest
- **包管理**: NPM Workspaces
- **基础设施**: AWS SAM
- **CI/CD**: GitHub Actions
- **部署**: AWS CLI + SAM

## 快速开始

### 1. 环境要求

- Node.js >= 24.0.0
- NPM >= 10.0.0
- AWS CLI (配置好凭证)
- AWS SAM CLI

### 2. 安装依赖

```bash
npm install
```

### 3. 本地开发

```bash
# 启动特定函数的本地开发
./infra/scripts/local.sh hello-world

# 构建所有函数
./infra/scripts/build.sh

# 构建特定函数
./infra/scripts/build.sh hello-world
```

### 4. 运行测试

```bash
# 运行所有测试
npm run test

# 运行特定包的测试
npm run test --workspace=functions/hello-world

# 运行测试并生成覆盖率报告
npm run test:coverage

# 运行集成测试
npm run test:integration

# 监听模式运行测试
npm run test:watch
```

### 5. 部署

```bash
# 部署到开发环境
./infra/scripts/deploy.sh dev

# 部署到生产环境
./infra/scripts/deploy.sh prod

# 部署特定函数
./infra/scripts/deploy.sh dev hello-world
```

## 添加新函数

1. 在 `functions/` 目录下创建新目录
2. 创建 `package.json` 和 `index.ts`
3. 在根 `package.json` 的 workspaces 中注册（自动）
4. 在 `infra/templates/template.yaml` 中添加资源定义
5. 运行 `npm install` 安装依赖

## 添加共享包

1. 在 `packages/` 目录下创建新目录
2. 创建 `package.json` 和 `index.ts`
3. 在函数中通过 `@ainx/package-name` 引用

## CI/CD 流程 (GitHub Flow)

本项目遵循 [GitHub Flow](https://docs.github.com/en/get-started/quickstart/github-flow) 工作流：

### 分支策略

- **`main`**: 唯一长期存在的分支，始终可部署
- **Feature branches**: 从 `main` 创建，通过 PR 合并回 `main`

### 自动触发

- **PR 到 main**: 运行 lint、type-check、test（单元测试 + 集成测试）
- **Push 到 main**: 自动部署到生产环境

### 手动触发

- **Deploy Single Function**: 手动部署特定函数到指定环境

## 环境变量

在 GitHub Secrets 中配置：

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION` (默认 us-east-1)

## 最佳实践

### 代码组织

- **函数隔离**: 每个 Lambda 函数独立目录，包含自己的 package.json
- **共享代码**: 通用逻辑放在 `packages/` 目录
- **类型安全**: 所有代码使用 TypeScript，启用严格模式

### 测试策略

- **单元测试**: 每个函数和包都必须有对应的单元测试
- **集成测试**: 测试 Lambda handler 的完整流程
- **覆盖率**: 目标覆盖率 > 80%
- **测试命名**: `*.test.ts` 为单元测试，`*.integration.test.ts` 为集成测试

### 部署策略

- **按需部署**: 使用路径过滤，只部署变更的函数
- **环境隔离**: dev/staging/prod 完全隔离
- **版本控制**: 使用 Lambda 别名和版本

### 监控和日志

- **X-Ray**: 启用分布式跟踪
- **CloudWatch**: 自动创建告警
- **结构化日志**: 使用 JSON 格式，包含上下文信息

### 安全

- **最小权限**: Lambda 函数使用最小 IAM 权限
- **环境变量**: 敏感信息通过 GitHub Secrets 管理
- **CORS**: API Gateway 配置跨域支持

## 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件

## 参考资源

- [AWS Lambda 最佳实践](https://aws.amazon.com/blogs/compute/best-practices-for-organizing-larger-serverless-applications)
- [AWS SAM 文档](https://docs.aws.amazon.com/serverless-application-model/)
- [NPM Workspaces](https://docs.npmjs.com/cli/v10/using-npm/workspaces)
- [GitHub Actions 文档](https://docs.github.com/en/actions)
- [esbuild 文档](https://esbuild.github.io/)
- [TypeScript 文档](https://www.typescriptlang.org/docs/)
- [Jest 文档](https://jestjs.io/docs/getting-started)
