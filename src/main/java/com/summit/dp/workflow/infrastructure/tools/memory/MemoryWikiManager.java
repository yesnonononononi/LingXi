package com.summit.dp.workflow.infrastructure.tools.memory;

import com.summit.core.runtime.workspace.Workspace;
import com.summit.dp.shared.exception.ClientException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.beans.factory.config.ConfigurableBeanFactory;
import org.springframework.context.annotation.Scope;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/** 索引只属于一次工具调用，不能在不同项目之间共享。 */
@Component
@Scope(ConfigurableBeanFactory.SCOPE_PROTOTYPE)
public class MemoryWikiManager {
    private final String relativeLocation;
    private Map<String, Path> wikis = Map.of();
    private Workspace workspace;
    private Path wikiRoot;

    public MemoryWikiManager(@Value("${lingxi.memory.wiki.relative-location:.lingxi/memory/wiki}") String relativeLocation) {
        this.relativeLocation = relativeLocation;
    }

    public List<String> getWikis() {
        return wikis.keySet().stream().sorted().toList();
    }

    public List<String> getLoadedWikis() {
        return MemoryWikiLimits.limitNames(getWikis());
    }

    /**
     * 目录快照，同时给出全部条数与本次返回条数。
     *
     * <p>只返回 {@code List} 会让裁剪变成静默截断：调用方看到的是 30 条，却无法判断库里是否还有更多。
     * {@code total} 与 {@code returned} 不同即说明被 {@link MemoryWikiLimits} 裁剪，调用方据此提示继续检索。</p>
     *
     * @return 目录快照，{@code wikis} 已按名称排序并受条数与字符预算约束；永不为 {@code null}
     */
    public Catalog catalog() {
        List<String> loaded = getLoadedWikis();
        return new Catalog(wikis.size(), loaded.size(), loaded);
    }

    public String findWikiDetail(String wiki) throws IOException {
        throwIf(wiki == null || wiki.isBlank(), "记忆 wiki 名称不能为空");
        Path path = wikis.get(wiki);
        if (path == null) return null;
        throwIf(!path.toRealPath().startsWith(wikiRoot), "记忆 wiki 文件不能指向目录外部");
        // 正文沿用文件工具的桥接入口，沙箱拒绝不能被宿主机直接读取绕过。
        return workspace.bridge().files().readString(path, StandardCharsets.UTF_8);
    }

    public void loadWikis(Workspace currentWorkspace) throws IOException {
        throwIf(currentWorkspace == null || currentWorkspace.workDir() == null
                || currentWorkspace.workDir().isBlank(), "读取记忆 wiki 需要绑定项目工作目录");
        Path projectRoot = Path.of(currentWorkspace.workDir()).normalize();

        throwIf(!projectRoot.isAbsolute(), "记忆 wiki 的项目工作目录必须是绝对路径");
        throwIf(relativeLocation == null || relativeLocation.isBlank(), "记忆 wiki 目录配置不能为空");

        Path relative = Path.of(relativeLocation);
        Path directory = currentWorkspace.resolve(relativeLocation).normalize();
        throwIf(relative.isAbsolute() || !directory.startsWith(projectRoot) || directory.equals(projectRoot),
                "记忆 wiki 目录必须位于项目工作目录内");

        // 加载失败或目录消失后不能保留旧项目的索引。
        wikis = Map.of();
        workspace = currentWorkspace;
        wikiRoot = null;
        if (!Files.exists(directory)) return;
        throwIf(!Files.isDirectory(directory), "记忆 wiki 目录配置指向了文件，请配置目录路径");
        Path realProjectRoot = projectRoot.toRealPath();
        Path realDirectory = directory.toRealPath();
        throwIf(!realDirectory.startsWith(realProjectRoot) || realDirectory.equals(realProjectRoot),
                "记忆 wiki 目录不能指向项目工作目录外部");

        Map<String, Path> loaded = new LinkedHashMap<>();
        try (Stream<Path> walk = Files.walk(realDirectory)) {
            // 不跟随符号链接，避免把项目外文件加入目录；相对路径保留子目录同名文档。
            walk.filter(path -> Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS))
                    .filter(path -> path.getFileName().toString().endsWith(".md"))
                    .sorted()
                    .forEach(path -> loaded.put(realDirectory.relativize(path).toString().replace('\\', '/'), path));
        }
        wikiRoot = realDirectory;
        wikis = Map.copyOf(loaded);
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }

    /**
     * 目录快照：{@code total} 为全部 wiki 数，{@code returned} 为本次返回条数，两者不同即表示被裁剪。
     *
     * @param total    全部 wiki 数
     * @param returned 本次返回条数
     * @param wikis    本次返回的 wiki 名称，按名称排序
     */
    public record Catalog(int total, int returned, List<String> wikis) {
        public Catalog {
            wikis = wikis == null ? List.of() : List.copyOf(wikis);
        }
    }
}
