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

### 2. 创建新功能

```bash
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
- 编写单元测试（覆盖率 > 80%）
- 遵循 Conventional Commits 规范

### 4. 提交 PR

1. 确保所有测试通过
2. 更新相关文档
3. 描述变更内容和原因
4. 关联相关 Issue

## 项目结构说明

### 函数开发

```
functions/
└── your-function/
    ├── package.json      # 函数依赖
    ├── index.ts          # 入口文件
    ├── handler.ts        # 业务逻辑
    └── __tests__/        # 测试文件
        └── index.test.ts
```

### 共享包开发

```
packages/
└── your-package/
    ├── package.json      # 包配置
    ├── index.ts          # 导出文件
    └── src/              # 源代码
```

## 代码审查标准

- 代码是否遵循项目规范
- 是否有适当的错误处理
- 是否包含测试
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
- 环境信息

## 联系方式

- GitHub Issues: [ainx/ainx-lambda/issues](https://github.com/ainx/ainx-lambda/issues)
- 邮箱: dev@ainx.com
