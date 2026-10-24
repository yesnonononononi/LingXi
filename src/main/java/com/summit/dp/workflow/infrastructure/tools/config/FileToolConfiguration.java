package com.summit.dp.workflow.infrastructure.tools.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.workflow.infrastructure.tools.file.record.Differ;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileHasher;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordManager;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordStore;
import com.summit.core.tool.*;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileHasher;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileRecordManager;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileRecordStore;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordRestorer;
import com.summit.dp.workflow.infrastructure.tools.file.edit.EditDiffer;
import com.summit.dp.workflow.infrastructure.tools.file.edit.EditFileToolExecutor;
import com.summit.dp.workflow.infrastructure.tools.file.read.ReadFileToolExecutor;
import com.summit.dp.workflow.infrastructure.tools.image.ImageCacheDirectory;
import com.summit.dp.workflow.infrastructure.tools.image.ImageNormalizer;
import com.summit.dp.workflow.infrastructure.tools.image.ReadImageToolExecutor;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;

/**
 * 文件读写工具的装配。
 *
 * <p>工具不再有 yaml {@code enabled} 开关：一个工具要么在本应用里存在，要么不存在 —— 装配由代码
 * 决定，而不是由某个部署恰好写没写一个键决定。这样「这个工具为什么没生效」不会再变成一个查配置
 * 文件的问题。要停用某个工具，从 Agent 的工具清单里去掉它即可（框架侧名单即授权）。</p>
 */
@org.springframework.context.annotation.Configuration(proxyBeanMethods = false)
public class FileToolConfiguration {
    @Bean
    @ConditionalOnMissingBean(name = "editFileToolDefinition")
    public ToolDefinition<EditFileToolExecutor> editFileToolDefinition(ObjectMapper objectMapper, FileRecordManager fileRecordManager, Differ differ) {
        String name = "edit_file";
        return ToolDefinition.<EditFileToolExecutor>builder()
                .executor(new EditFileToolExecutor(objectMapper, differ, fileRecordManager))
                .id(name)
                .name(name)
                .concurrentPolicy(ConcurrentPolicy.SERIAL_MUTATION)
                .description("Edit UTF-8 text using exact, unique oldText or anchor matches. Supports REPLACE, INSERT_BEFORE, INSERT_AFTER and DELETE; INSERT_* can create files. Returns an edit summary.")
                .parametersJsonSchema("""
                        {
                          "type": "object",
                          "properties": {
                            "type": {"type": "string", "enum": ["INSERT_BEFORE", "INSERT_AFTER", "REPLACE", "DELETE"], "description": "INSERT_* : insert content behind or in front of anchor. "},
                            "anchor": {"type": "string", "description": "The anchor of Insert operation it is a required parameter if type in terms of INSERT unless want to insert a empty file"},
                            "path": {"type": "string", "description": "File path relative to the workspace root. Do not use absolute paths it is a required parameter"},
                            "oldText": {"type": "string", "description": "Exact original text, required for REPLACE and DELETE. Must match exactly once."},
                            "newText": {"type": "string", "description": "Required for REPLACE and INSERT_*. An explicit empty string is allowed for REPLACE. Ignored for DELETE."}
                          },
                          "required": ["type", "path"]
                        }
                        """)
                .maxOutput(200)
                .timeout(30L)
                .build();
    }

    @Bean
    @ConditionalOnMissingBean(name = "readFileToolDefinition")
    public ToolDefinition<ReadFileToolExecutor> readFileToolDefinition(ObjectMapper objectMapper) {
        String name = "read_file";
        return ToolDefinition.<ReadFileToolExecutor>builder()
                .executor(new ReadFileToolExecutor(objectMapper))
                .id(name)
                .name(name)
                .description("Read file content, optionally limited to a startLine/endLine range.")
                .parametersJsonSchema("""
                        {
                          "type": "object",
                          "properties": {
                            "path": {"type": "string", "description": "File path it is a required parameter"},
                            "startLine": {"type": "integer", "minimum": 0, "description": "Zero-based start line, inclusive. Defaults to 0. Omit both line bounds to read the entire file."},
                            "endLine": {"type": "integer", "minimum": 0, "description": "Zero-based end line, inclusive. Must not precede startLine. Defaults to the last line."}
                          },
                          "required": ["path"]
                        }
                        """)
                .concurrentPolicy(ConcurrentPolicy.READ_ONLY)
                .maxOutput(3_000)
                .timeout(30L)
                .build();
    }

    @Bean
    @ConditionalOnMissingBean(name = "readImageToolDefinition")
    public ToolDefinition<ReadImageToolExecutor> readImageToolDefinition(
            ObjectMapper objectMapper,
            ImageNormalizer imageNormalizer,
            ImageCacheDirectory imageCacheDirectory) {
        String name = ToolCatalog.READ_IMAGE;
        return ToolDefinition.<ReadImageToolExecutor>builder()
                .executor(new ReadImageToolExecutor(objectMapper, imageNormalizer, imageCacheDirectory))
                .id(name)
                .name(name)
                // 只读：解码与落盘都在工作区/缓存目录内完成，不改动用户文件。
                .concurrentPolicy(ConcurrentPolicy.READ_ONLY)
                .description("""
                        Load one image from the workspace into your context so you can actually see it.
                        The pixels are not inside this result: you get image metadata now, and the image itself
                        arrives as a separate user message on your next turn, still within this same task.
                        Images consume model input tokens; one execution may receive at most 15 distinct images.
                        Only PNG/JPEG/GIF/BMP are accepted; the path must stay inside the workspace.
                        """)
                .parametersJsonSchema("""
                        {
                          "type": "object",
                          "properties": {
                            "path": {"type": "string", "description": "Image path inside the workspace. Relative paths are resolved against the workspace root."}
                          },
                          "required": ["path"]
                        }
                        """)
                .maxOutput(400)
                .timeout(20L)
                .build();
    }

    @Bean
    @ConditionalOnMissingBean
    public ImageNormalizer imageNormalizer() {
        return new ImageNormalizer();
    }

    @Bean
    @ConditionalOnMissingBean
    public Differ differ(){
        return new EditDiffer();
    }

    @Bean
    @ConditionalOnMissingBean
    public FileRecordStore fileRecordStore(){
        return new DefaultFileRecordStore();
    }

    @Bean
    @ConditionalOnMissingBean
    public FileHasher fileHasher() {
        return new DefaultFileHasher();
    }

    @Bean
    @ConditionalOnMissingBean
    public FileRecordManager fileRecordManager(FileRecordStore fileRecordStore, FileHasher fileHasher) {
        return new DefaultFileRecordManager(fileRecordStore, new FileRecordRestorer(fileHasher), fileHasher);
    }

}
