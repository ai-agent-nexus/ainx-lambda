# 贡献指南

感谢您对 AINX Lambda 项目的关注！以下是贡献代码的指南。

## 开发流程

### 1. 环境设置

```bash
# 克隆仓库
git clone https://github.com/ainx/ainx-lambda.git
cd ainx-lambda

# 安装依赖
npm install

# 验证环境
npm run lint
npm run test
```

### 2. 创建新功能 (GitHub Flow)

```bash
# 确保你在 main 分支上
 git checkout main
 git pull origin main

# 创建功能分支
git checkout -b feature/your-feature-name

# 开发代码
# ...

# 运行测试
npm run test

# 提交代码
git add .
git commit -m "feat: add new feature"
```

### 3. 代码规范

- 使用 TypeScript 严格模式
- 所有函数必须有类型定义
- 使用 ESLint 和 Prettier 格式化代码
- **编写单元测试**（覆盖率 > 80%）
- **编写集成测试**（针对 Lambda handler）
- 遵循 Conventional Commits 规范

### 4. 提交 PR

1. 确保所有测试通过（单元测试 + 集成测试）
2. 确保代码覆盖率 > 80%
3. 更新相关文档
4. 描述变更内容和原因
5. 关联相关 Issue

## 项目结构说明

### 函数开发

```
functions/
└── your-function/
    ├── package.json      # 函数依赖
    ├── index.ts          # 入口文件
    ├── handler.ts        # 业务逻辑
    └── __tests__/        # 测试文件
        ├── index.test.ts           # 单元测试
        └── index.integration.test.ts  # 集成测试
```

### 共享包开发

```
packages/
└── your-package/
    ├── package.json      # 包配置
    ├── index.ts          # 导出文件
    ├── src/              # 源代码
    └── __tests__/        # 测试文件
        └── index.test.ts
```

## 测试规范

### 测试要求

- **所有函数和包都必须有测试**
- **单元测试**: 测试单个函数或模块的逻辑
- **集成测试**: 测试 Lambda handler 的完整流程
- **覆盖率目标**: > 80%

### 测试命令

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

### 测试示例

```typescript
// __tests__/index.test.ts
import { handler } from '../index';

describe('hello-world handler', () => {
  it('should return 200 with hello message', async () => {
    const result = await handler(mockEvent as APIGatewayProxyEvent);
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain('Hello from AINX Lambda!');
  });
});
```

## 代码审查标准

- 代码是否遵循项目规范
- 是否有适当的错误处理
- **是否包含测试（单元测试 + 集成测试）**
- **测试覆盖率是否 > 80%**
- 性能是否优化
- 安全性是否考虑

## 发布流程

1. 版本号遵循 [SemVer](https://semver.org/)
2. 更新 CHANGELOG.md
3. 创建 GitHub Release
4. CI/CD 自动部署

## 问题报告

使用 GitHub Issues 报告问题，包含：

- 问题描述
- 复现步骤
- 期望行为
- 实际行为
- 环境信息（Node.js 版本、操作系统等）

## 联系方式

- GitHub Issues: [ainx/ainx-lambda/issues](https://github.com/ainx/ainx-lambda/issues)
- 邮箱: dev@ainx.com
