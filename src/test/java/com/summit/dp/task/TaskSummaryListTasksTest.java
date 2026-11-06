package com.summit.dp.task;

import com.baomidou.mybatisplus.annotation.DbType;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.shared.support.SqlCaptureInterceptor;
import com.summit.dp.task.application.service.TaskDeletionPolicy;
import com.summit.dp.task.application.vo.TaskVO;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.task.domain.model.Task.TaskStatus;
import com.summit.dp.task.domain.repository.TaskRepository;
import com.summit.dp.task.infrastructure.persistence.mapper.TaskMapper;
import com.summit.dp.task.infrastructure.repository.TaskRepositoryImpl;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackendProcessManager;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskBroadcaster;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskCompletion;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;

/**
 * 后台任务列表不得读 {@code output} CLOB。
 *
 * <p>列表一次性取 50 行，每行带上最长的一个 CLOB —— 这一条路径的下发语句里只要出现
 * {@code output}，50 行命令输出全文就都要经 H2 的 {@code copyLob} 走一遍临时 LOB 写。
 * 裁剪后仍要保证展示字段（命令、意图、状态、退出码）与「旧活跃任务不被挤出首页」都还在。</p>
 */
class TaskSummaryListTasksTest {

    private static final long SESSION_ID = 10L;
    private static final long TURN_ID = 20L;
    private static final int LONG_COMMAND_LENGTH = 300;

    private H2TestDatabase database;
    private SqlCaptureInterceptor capture;
    private TaskRepository repository;
    private BackendProcessManager manager;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("TaskSummaryListTasksTest");
        capture = new SqlCaptureInterceptor();
        MybatisConfiguration configuration = database.configuration(TaskMapper.class);
        configuration.addInterceptor(capture);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        MybatisPlusInterceptor plugins = new MybatisPlusInterceptor();
        plugins.addInnerInterceptor(new PaginationInnerInterceptor(DbType.H2));
        factory.setPlugins(plugins);
        SqlSessionFactory sessionFactory = factory.getObject();
        repository = new TaskRepositoryImpl(H2TestDatabase.sqlSession(sessionFactory).getMapper(TaskMapper.class));
        manager = new BackendProcessManager(repository, mock(BackgroundTaskBroadcaster.class),
                mock(BackgroundTaskCompletion.class), mock(TaskDeletionPolicy.class));
        seedTasks();
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    @DisplayName("列表查询不投影 output，但保留 command_text / intention 等展示列")
    void listQueryOmitsOutputColumn() {
        capture.clear();
        List<TaskVO> tasks = manager.listTasks(SESSION_ID);

        assertFalse(capture.queries().isEmpty(), "列表必须真的查库");
        for (String query : capture.queries()) {
            String sql = SqlCaptureInterceptor.normalize(query);
            assertFalse(sql.contains("output"), "列表查询不得投影 output 列，实际: " + sql);
        }
        String pageQuery = capture.queries().stream()
                .map(SqlCaptureInterceptor::normalize)
                .filter(sql -> sql.contains("order by id desc"))
                .findFirst().orElseThrow(() -> new AssertionError("未找到列表分页查询: " + capture.queries()));
        assertTrue(pageQuery.contains("command_text"), "命令列必须保留，实际: " + pageQuery);
        assertTrue(pageQuery.contains("intention"), "意图列必须保留，实际: " + pageQuery);
        assertTrue(pageQuery.contains("exit_code"), "退出码列必须保留，实际: " + pageQuery);

        assertEquals(51, tasks.size(), "最近 50 条历史 + 1 条旧的活跃任务");
    }

    @Test
    @DisplayName("展示字段不丢：命令截断到 256、output 为 null、旧活跃任务仍在")
    void viewKeepsDisplayFieldsAndDropsOutput() {
        List<TaskVO> tasks = manager.listTasks(SESSION_ID);

        assertTrue(tasks.stream().allMatch(task -> task.getOutput() == null), "列表不下发输出全文");
        TaskVO newest = tasks.stream().filter(task -> task.getId() == 52L).findFirst().orElseThrow();
        assertEquals(257, newest.getCommand().length(), "超长命令必须截断成 256 字符 + 省略号");
        assertTrue(newest.getCommand().endsWith("…"));
        assertEquals("意图说明", newest.getIntention(), "意图必须照常下发");
        assertEquals("SUCCESS", newest.getStatus());
        assertEquals(0, newest.getExitCode());

        TaskVO active = tasks.stream().filter(task -> task.getId() == 1L).findFirst()
                .orElseThrow(() -> new AssertionError("旧的活跃任务不能被最近 50 条挤掉"));
        assertEquals("PENDING", active.getStatus());
        assertEquals("long running", active.getCommand());
    }

    @Test
    @DisplayName("金丝雀：全列查询确实会带上 output —— 证明上面的「不含」断言不是空断言")
    void fullColumnQueryDoesSelectOutput() {
        capture.clear();
        repository.queryPageBySessionId(1, 50, SESSION_ID);

        String sql = capture.queries().stream()
                .map(SqlCaptureInterceptor::normalize)
                .filter(query -> query.contains("select id,"))
                .findFirst().orElseThrow(() -> new AssertionError("未找到全列查询: " + capture.queries()));
        assertTrue(sql.contains("output"), "全列查询应带上 output 列，实际: " + sql);
    }

    @Test
    @DisplayName("摘要仓储的 active 查询同样不投影 output")
    void activeSummaryQueryOmitsOutputColumn() {
        capture.clear();
        repository.findActiveSummaryBySessionId(SESSION_ID);

        assertEquals(1, capture.queries().size(), "活跃摘要是一次查询，实际: " + capture.queries());
        String sql = SqlCaptureInterceptor.normalize(capture.queries().getFirst());
        assertFalse(sql.contains("output"), "活跃摘要查询不得投影 output 列，实际: " + sql);
        assertTrue(sql.contains("command_text"), "实际: " + sql);
    }

    /** 铺 1 条旧的活跃任务 + 51 条已完成任务（最新一条带超长命令与大输出）。 */
    private void seedTasks() {
        repository.save(Task.builder().id(1L).sessionId(SESSION_ID).turnId(TURN_ID)
                .command("long running").build());
        for (long id = 2; id <= 52; id++) {
            Task task = Task.builder().id(id).sessionId(SESSION_ID).turnId(TURN_ID)
                    .command(id == 52L ? "长命令".repeat(100) : "finished")
                    .intention(id == 52L ? "意图说明" : null)
                    .build();
            task.finish(TaskStatus.SUCCESS, id == 52L ? "输出正文".repeat(2000) : "", 0, false);
            repository.save(task);
        }
        // 前提校验走仓储整行读回（不直接查业务表），随后各用例自己 clear 再量被测调用。
        Task latest = repository.findById(52L).orElseThrow();
        assertEquals(LONG_COMMAND_LENGTH, latest.getCommand().length(), "前提：命令文本要够长才会被截断");
        assertTrue(latest.getOutput() != null && latest.getOutput().length() > 256,
                "前提：最新一条的输出必须超过行内阈值，否则「没读 CLOB」的断言没有意义");
    }
}
