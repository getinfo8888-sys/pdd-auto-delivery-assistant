# GitHub 维护与发布

仓库保存源码和公开文档。普通使用者从仓库右侧 **Releases** 下载 Windows 安装包，开发者才需要下载源码和安装 Node.js。

## 第一次连接

1. 登录自己的 GitHub 账号，创建公开仓库；导入现有项目时不要预先添加 README、许可证或 .gitignore。
2. 在本机安装 Git 与 GitHub CLI，执行 `gh auth login`，由本人在 GitHub 网页完成授权。不要将密码、访问令牌或验证码发到聊天或写进项目。
3. 设置本仓库的 Git 作者名称和 GitHub 提供的 noreply 邮箱，核对开源许可证。
4. 检查公开文件，创建首次提交，添加 origin 后推送。

本项目的 `work/`、`dist/`、店铺规则、浏览器数据、研究材料和本地日志均不进入 Git。`npm run check:public` 还会检查待提交文件中的常见凭据、私人路径和意外文件。

## 日常更新

每次完成一轮更新后，检查改动并验证，再提交推送：

```powershell
npm run check:public
npm test
git status
git add README.md CHANGELOG.md package.json package-lock.json src scripts test .github AGENTS.md CONTRIBUTING.md .gitignore .gitattributes docs/使用说明.md docs/开发说明.md docs/GitHub发布说明.md
git diff --cached --stat
npm run check:public
git commit -m "说明这次具体改动"
git push
```

不要把未完成的临时编辑实时自动推到公开仓库。维护助手应在每次功能或修复完成并通过验证后提交和推送，具体约定见根目录 `AGENTS.md`。

推送分支和创建 Pull Request 后，GitHub Actions 会执行公开文件检查和单元测试。它们不连接真实店铺。

## 发布新版安装包

更新 `package.json` 与 `package-lock.json` 中的版本，补充 `CHANGELOG.md`，提交并推送。然后推送与版本一致的标签：

```powershell
git tag v版本号
git push origin v版本号
```

例如 package.json 为 0.3.10 时，标签为 v0.3.10。标签不能重复用于替换旧版本；新更新应使用新的版本号。

`Windows release` 工作流会在 Windows 上安装依赖、检查源码、运行单元与隔离工作流测试、生成安装包和便携程序、核对包内源码并计算 SHA256，最后发布到 Releases。工作流只使用 GitHub 自带的临时令牌，不需要把个人 Token 填进项目。

发布完成后核对 Actions 成功、Release 资产齐全。需要给别人使用时分享仓库首页或 Releases 链接，提醒对方下载 `.exe` 安装包；GitHub 自动生成的 Source code ZIP 是源码。

工作流自动执行需要仓库允许 GitHub Actions，并允许对应 Release 作业写入仓库。网络或构建失败时，不会把失败构建发布成新版；在 Actions 中查看具体错误后修正并重跑。

当前未配置代码签名和应用内自动升级。GitHub Release 发布与用户电脑自动升级是两件事，用户仍需下载并安装新版。
