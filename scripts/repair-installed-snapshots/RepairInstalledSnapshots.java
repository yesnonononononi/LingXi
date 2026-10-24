import com.alibaba.druid.pool.DruidDataSource;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.Message;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.execution.application.service.impl.ExecutionQueryServiceImpl;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionContextMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionContextPO;
import com.summit.dp.session.infrastructure.persistence.repository.SessionContextRepositoryImpl;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.application.chat.ResendTargetResolver;
import org.mybatis.spring.SqlSessionTemplate;
import org.apache.ibatis.logging.nologging.NoLoggingImpl;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.file.Files;
import java.nio.file.Path;
import java.lang.reflect.Method;
import java.util.List;
import java.util.stream.Stream;

/** 仅供停机维护：使用目标安装包的类型校验，并在同一事务内恢复旧版快照格式。 */
public final class RepairInstalledSnapshots {
    private record Patch(String json, int removedFields) {
    }

    public static void main(String[] args) throws Exception {
        ObjectMapper json = new JsonConfig().objectMapper();
        if (args.length == 1 && "self-test".equals(args[0])) {
            selfTest(json);
            return;
        }
        throwIf(args.length != 3 || !("inspect".equals(args[0]) || "apply".equals(args[0]) || "verify".equals(args[0])),
                "参数应为 inspect、apply 或 verify、数据库目录、修复前快照备份目录");
        Path data = Path.of(args[1]).toAbsolutePath().normalize();
        throwIf(!Files.isRegularFile(data.resolve("lingxi.mv.db")), "指定目录中没有安装版数据库");
        Path backup = Path.of(args[2]).toAbsolutePath().normalize();
        boolean apply = "apply".equals(args[0]);
        try (DruidDataSource source = new DruidDataSource()) {
            source.setDriverClassName("org.h2.Driver");
            source.setUrl("jdbc:h2:file:" + data.resolve("lingxi").toString().replace('\\', '/')
                    + ";MODE=MySQL;IFEXISTS=TRUE");
            source.setUsername("sa");
            source.setPassword("");
            source.setInitialSize(0);
            source.setMaxActive(1);
            source.setValidationQuery("SELECT 1");
            MybatisConfiguration configuration = new MybatisConfiguration();
            configuration.setLogImpl(NoLoggingImpl.class);
            configuration.setMapUnderscoreToCamelCase(true);
            configuration.addMapper(ExecutionMapper.class);
            configuration.addMapper(SessionContextMapper.class);
            MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
            factory.setDataSource(source);
            factory.setConfiguration(configuration);
            SqlSessionTemplate sessions = new SqlSessionTemplate(factory.getObject());
            ExecutionMapper executions = sessions.getMapper(ExecutionMapper.class);
            SessionContextMapper contexts = sessions.getMapper(SessionContextMapper.class);
            if ("verify".equals(args[0])) {
                verifyPatchedRows(json, executions, contexts, backup);
                return;
            }
            new TransactionTemplate(new DataSourceTransactionManager(source)).execute(status -> {
                try {
                    long totalExecutions = executions.selectCount(null);
                    long totalContexts = contexts.selectCount(null);
                    int executionRows = 0;
                    int contextRows = 0;
                    int removedFields = 0;
                    List<ExecutionPO> executionCandidates = executions.selectList(Wrappers.<ExecutionPO>lambdaQuery()
                            .like(ExecutionPO::getSnapshot, "\"exitCode\"")
                            .or().like(ExecutionPO::getSnapshot, "\"compactionState\""));
                    for (ExecutionPO row : executionCandidates) {
                        Patch patch = rewrite(json, row.getSnapshot());
                        if (patch.removedFields() == 0) continue;
                        json.readValue(patch.json(), Execution.class);
                        if (apply) {
                            Files.createDirectories(backup);
                            Files.writeString(backup.resolve("execution-" + row.getId() + ".json"), row.getSnapshot());
                            int updated = executions.update(null, Wrappers.<ExecutionPO>lambdaUpdate()
                                    .eq(ExecutionPO::getId, row.getId()).eq(ExecutionPO::getVersion, row.getVersion())
                                    .set(ExecutionPO::getSnapshot, patch.json())
                                    .set(ExecutionPO::getVersion, row.getVersion() + 1)
                                    .set(ExecutionPO::getUpdatedAt, row.getUpdatedAt()));
                            throwIf(updated != 1, "执行快照在修复期间发生变化，已回滚全部修复");
                            json.readValue(executions.selectById(row.getId()).getSnapshot(), Execution.class);
                        }
                        executionRows++;
                        removedFields += patch.removedFields();
                        System.out.println("校验执行快照: executionId=" + row.getId() + ", removedFields=" + patch.removedFields());
                    }
                    List<SessionContextPO> contextCandidates = contexts.selectList(Wrappers.<SessionContextPO>lambdaQuery()
                            .like(SessionContextPO::getContent, "\"exitCode\""));
                    for (SessionContextPO row : contextCandidates) {
                        Patch patch = rewrite(json, row.getContent());
                        if (patch.removedFields() == 0) continue;
                        json.readValue(patch.json(), new TypeReference<List<Message>>() { });
                        if (apply) {
                            Files.createDirectories(backup);
                            Files.writeString(backup.resolve("session-context-" + row.getSessionId() + ".json"), row.getContent());
                            int updated = contexts.update(null, Wrappers.<SessionContextPO>lambdaUpdate()
                                    .eq(SessionContextPO::getSessionId, row.getSessionId())
                                    .eq(SessionContextPO::getVersion, row.getVersion())
                                    .set(SessionContextPO::getContent, patch.json())
                                    .set(SessionContextPO::getVersion, row.getVersion() + 1)
                                    .set(SessionContextPO::getUpdateTime, row.getUpdateTime()));
                            throwIf(updated != 1, "会话上下文在修复期间发生变化，已回滚全部修复");
                            json.readValue(contexts.selectById(row.getSessionId()).getContent(), new TypeReference<List<Message>>() { });
                        }
                        contextRows++;
                        removedFields += patch.removedFields();
                        System.out.println("校验会话上下文: sessionId=" + row.getSessionId() + ", removedFields=" + patch.removedFields());
                    }
                    throwIf(totalExecutions != executions.selectCount(null) || totalContexts != contexts.selectCount(null),
                            "修复前后记录数量发生变化，已回滚全部修改");
                    System.out.println("快照修复完成: applied=" + apply + ", executionRows=" + executionRows
                            + ", contextRows=" + contextRows + ", removedFields=" + removedFields
                            + ", totalExecutions=" + totalExecutions + ", totalContexts=" + totalContexts);
                    return null;
                } catch (Exception failure) {
                    throw new IllegalStateException("快照修复失败，已回滚全部修改", failure);
                }
            });
        }
    }

    private static void verifyPatchedRows(ObjectMapper json, ExecutionMapper executions,
                                          SessionContextMapper contexts, Path backup) throws Exception {
        ResendTargetResolver resolver = new ResendTargetResolver(null, null,
                new ExecutionQueryServiceImpl(new ExecutionRepositoryImpl(executions)), json);
        Method baseline = ResendTargetResolver.class.getDeclaredMethod("resolveBaseline", Long.class);
        baseline.setAccessible(true);
        ModelContextService modelContexts = new ModelContextService(json, new SessionContextRepositoryImpl(contexts));
        int checked = 0;
        try (Stream<Path> files = Files.list(backup)) {
            for (Path file : files.toList()) {
                String name = file.getFileName().toString();
                if (name.startsWith("execution-") && name.endsWith(".json")) {
                    Long id = Long.valueOf(name.substring("execution-".length(), name.length() - ".json".length()));
                    List<?> messages = (List<?>) baseline.invoke(resolver, id);
                    System.out.println("安装版重发准备通过: executionId=" + id + ", baselineMessages=" + messages.size());
                    checked++;
                } else if (name.startsWith("session-context-") && name.endsWith(".json")) {
                    Long id = Long.valueOf(name.substring("session-context-".length(), name.length() - ".json".length()));
                    List<Message> messages = modelContexts.find(id).orElseThrow(ClientException::new);
                    System.out.println("安装版上下文读取通过: sessionId=" + id + ", messages=" + messages.size());
                    checked++;
                }
            }
        }
        throwIf(checked == 0, "备份目录中没有可验证的快照，不能据此判定修复成功");
    }

    private static Patch rewrite(ObjectMapper json, String value) throws Exception {
        JsonNode tree = json.readTree(value);
        int removed = removeUnsupportedField(tree);
        if (tree instanceof ObjectNode execution && execution.has("agentRequest")
                && execution.has("executionState") && execution.has("compactionState")) {
            execution.remove("compactionState");
            removed++;
        }
        return new Patch(removed == 0 ? value : json.writeValueAsString(tree), removed);
    }

    private static int removeUnsupportedField(JsonNode node) {
        int removed = 0;
        if (node instanceof ObjectNode object && "TOOL".equals(object.path("type").asText())
                && object.has("exitCode")) {
            object.remove("exitCode");
            removed++;
        }
        for (JsonNode child : node) removed += removeUnsupportedField(child);
        return removed;
    }

    private static void selfTest(ObjectMapper json) throws Exception {
        String tool = "[{\"type\":\"TOOL\",\"id\":\"canary\",\"name\":\"probe\","
                + "\"toolOutput\":\"keep exitCode text\",\"error\":false,\"exitCode\":null}]";
        try {
            json.readValue(tool, new TypeReference<List<Message>>() { });
            throw new AssertionError("自检必须使用不支持 exitCode 的安装包依赖");
        } catch (UnrecognizedPropertyException expected) {
            throwIf(!"exitCode".equals(expected.getPropertyName()), "自检失败原因不是预期字段");
        }
        Patch context = rewrite(json, tool);
        List<Message> restored = json.readValue(context.json(), new TypeReference<List<Message>>() { });
        throwIf(context.removedFields() != 1 || !"keep exitCode text".equals(restored.getFirst().text()),
                "修复丢失了工具正文或没有移除目标字段");
        Patch execution = rewrite(json, "{\"executionState\":\"CREATED\",\"compactionState\":{\"summaryGeneration\":0},"
                + "\"messages\":" + tool + ",\"agentRequest\":{\"messages\":" + tool + "}}");
        json.readValue(execution.json(), Execution.class);
        throwIf(execution.removedFields() != 3, "执行压缩状态与内嵌消息没有同时修复");
        throwIf(rewrite(json, context.json()).removedFields() != 0, "重复执行修复不应再次修改快照");
        throwIf(rewrite(json, "{\"exitCode\":7}").removedFields() != 0, "修复误删了工具消息之外的同名字段");
        try {
            json.readValue(context.json().replace("\"probe\"", "\"probe\",\"unknownCanary\":1"),
                    new TypeReference<List<Message>>() { });
            throw new AssertionError("未知字段严格校验被关闭");
        } catch (UnrecognizedPropertyException expected) {
            throwIf(!"unknownCanary".equals(expected.getPropertyName()), "未知字段正对照失败");
        }
        System.out.println("快照修复自检通过: strictUnknownFields=true, nestedMessages=true, idempotent=true");
    }

    private static void throwIf(boolean condition, String message) {
        if (condition) throw new ClientException(message);
    }
}
