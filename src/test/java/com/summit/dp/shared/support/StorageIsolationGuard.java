package com.summit.dp.shared.support;

import java.nio.file.Path;
import java.util.List;

/**
 * 测试与工具的禁区判定（设计 §附录D.3）。
 *
 * <p><b>为什么要有这条守卫</b>：本机同时存在两份「真数据」——正在被前后端使用的开发库目录
 * （{@code <仓库根>/.lingxi/development/data}）与用户的安装版数据目录
 * （{@code %USERPROFILE%/.lingxi/data}，574 MB 旧库）。任何用例或演练脚本只要把库建到这两个目录，
 * 就可能一边跑测试一边"迁走/覆盖"用户数据。规则只有一条：命中即抛，<b>不允许用「跳过」代替失败</b>。</p>
 *
 * <p>判定基于规范化绝对路径的 {@code startsWith}：连带它们的父目录一并拒绝，避免
 * 「往上一层找位置」绕过。</p>
 */
public final class StorageIsolationGuard {

    private StorageIsolationGuard() {
    }

    /** 当前进程认定的禁区绝对路径清单（供报告与断言打印）。 */
    public static List<Path> forbiddenRoots() {
        return List.of(userDataDir(), developmentDataDir());
    }

    /** 用户安装版数据目录（{@code %USERPROFILE%\.lingxi\data}）。 */
    public static Path userDataDir() {
        return Path.of(System.getProperty("user.home"), ".lingxi", "data").toAbsolutePath().normalize();
    }

    /** 工作区开发数据目录（{@code <仓库根>\.lingxi\development\data}）。 */
    public static Path developmentDataDir() {
        return repoRoot().resolve(".lingxi").resolve("development").resolve("data")
                .toAbsolutePath().normalize();
    }

    /**
     * 路径是否落在禁区内（含禁区本身、其下的任意子路径，以及它们的父目录）。
     *
     * @param candidate 待判定路径
     * @return {@code true} 表示禁止写入/禁止用作数据目录
     */
    public static boolean isForbidden(Path candidate) {
        if (candidate == null) {
            return true;
        }
        Path normalized = candidate.toAbsolutePath().normalize();
        for (Path root : forbiddenRoots()) {
            if (normalized.startsWith(root) || root.startsWith(normalized)) {
                return true;
            }
        }
        return false;
    }

    /**
     * 命中禁区即抛；用例与迁移/演练工具都必须先过这一关。
     *
     * @param candidate 待用作数据目录的路径
     * @throws IllegalArgumentException 命中禁区
     */
    public static void require(Path candidate) {
        if (isForbidden(candidate)) {
            throw new IllegalArgumentException("路径命中禁区，拒绝使用（可能覆盖真实用户数据）: "
                    + (candidate == null ? "null" : candidate.toAbsolutePath().normalize())
                    + "，禁区=" + forbiddenRoots());
        }
    }

    /** 仓库根：从 user.dir 逐级向上找包含 {@code src} 与 {@code .lingxi} 的目录。 */
    private static Path repoRoot() {
        Path dir = Path.of(System.getProperty("user.dir")).toAbsolutePath().normalize();
        for (int hops = 0; hops < 5 && dir != null; hops++, dir = dir.getParent()) {
            if (java.nio.file.Files.isDirectory(dir.resolve("src"))) {
                return dir;
            }
        }
        return Path.of(System.getProperty("user.dir")).toAbsolutePath().normalize();
    }
}
