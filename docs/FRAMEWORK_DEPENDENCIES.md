# 框架源码联调与 CI 构建

`framework-deps.lock.json` 记录 Harness、DDD 的仓库、完整 commit SHA 和 Maven 版本。
本地桌面构建、Backend CI 和 Release 均检出这份锁定的源码，先运行框架 `clean install`，
再构建业务，无需先向 Maven Central deploy。框架安装保留测试，只跳过发布签名与 Javadoc。

源码保存在 `.run/frameworks/`，Maven 仓库保存在 `.run/maven/<锁定内容摘要>/`。
框架和业务使用同一仓库；不同锁定提交使用不同仓库，避免同版本旧 JAR 混入。
源码缓存如果有本地修改、提交或版本不匹配，构建会立即失败，不会自动覆盖修改或改用远端旧 JAR。

## 日常更新

1. 在框架仓完成修改、测试、commit 和 push，取得完整 commit SHA。
2. 如果 Maven 版本改变，先同步业务 `pom.xml` 与锁定文件里的 `version`。
3. 在业务仓的 `frontend` 目录执行：

```powershell
npm run framework:lock -- harness <完整commitSHA>
# DDD 同理：npm run framework:lock -- ddd <完整commitSHA>
npm run backend:verify
```

锁定命令先验证远端提交的源码坐标和版本，成功后才更新文件。
将锁定文件与业务适配一同提交。框架未 push 的提交无法供 CI 使用。

## 构建入口

```powershell
npm run framework:prepare   # 检出并安装两个锁定框架，打印 Maven 仓库路径
npm run backend:test        # 安装锁定框架后执行业务测试
npm run backend:verify      # 安装锁定框架后验证、打包业务
npm run backend:runtime     # 安装锁定框架并打包业务，再生成桌面内置 JRE
```

普通 `mvn` 仍使用它自己的默认仓库。需要复用锁定源码产物时，使用上述入口，
或将 `framework:prepare` 打印的路径传给 `-Dmaven.repo.local`。

`--offline` 要求锁定源码与该隔离仓库中的所有构建依赖已经存在，不会联网补取。
`backend:runtime -- --skip-jar` / `--jar=...` 明确复用已有 JAR，不重新构建框架或业务；
Release 固定使用完整构建入口。框架 commit SHA 会写入 GitHub 构建摘要。

首次运行需联网获取源码及 Maven 依赖。当前两个框架仓均公开；若改为私有仓库，
需为构建进程配置只读 Git 凭据。源码构建只执行 `install`，不上传 Maven 包。
