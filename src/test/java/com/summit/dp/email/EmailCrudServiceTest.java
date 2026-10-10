package com.summit.dp.email;

import cn.hutool.core.util.IdUtil;
import com.baomidou.mybatisplus.annotation.DbType;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.email.application.command.EmailMessageCommand;
import com.summit.dp.email.application.command.MailSendContext;
import com.summit.dp.email.application.service.impl.EmailServiceImpl;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.email.application.vo.EmailVO;
import com.summit.dp.email.domain.model.Email;
import com.summit.dp.email.domain.model.EmailMessage;
import com.summit.dp.email.domain.repository.EmailMessageRepository;
import com.summit.dp.email.domain.repository.EmailRepository;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMapper;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMessageMapper;
import com.summit.dp.email.infrastructure.repository.EmailMessageRepositoryImpl;
import com.summit.dp.email.infrastructure.repository.EmailRepositoryImpl;
import com.summit.dp.shared.exception.ClientException;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Email 聚合回归（H2 手工装配，镜像 init.sql 的 email / email_message 两表，含业务键唯一约束）。
 *
 * <p>邮箱语义：协作根会话里、一个收件 Agent 的角色邮箱，业务键
 * {@code (workflow_execution_id, recipient_agent_id)}，其中 {@code workflow_execution_id} 是
 * <b>协作根会话 id</b>（列名保持历史命名），使同一根会话的各轮执行共享同一把邮箱键。覆盖：
 * sendMail 取邮箱 + 落 PENDING 消息 → findById（装载消息）→ findPage 过滤分页（不装载）→ del 事务内级联；
 * message add/list/updateContent/consume；consumePending 精确消费与隔离；hasPending 只读判定；
 * 并发首次建箱只建一条、并发消费只交付一次。校验失败一律抛 ClientException；
 * 业务数据准备一律走 Mapper/仓储。</p>
 */
class EmailCrudServiceTest {

    private EmbeddedDatabase database;
    private EmailMapper emailMapper;
    private EmailMessageMapper messageMapper;
    private EmailRepository emailRepository;
    private EmailMessageRepository messageRepository;
    private EmailServiceImpl service;

    @BeforeEach
    void setup() throws Exception {
        database = new EmbeddedDatabaseBuilder().generateUniqueName(true).setType(EmbeddedDatabaseType.H2)
                .addScript("email-schema.sql").build();
        MybatisConfiguration configuration = new MybatisConfiguration();
        configuration.setMapUnderscoreToCamelCase(true);
        configuration.addMapper(EmailMapper.class);
        configuration.addMapper(EmailMessageMapper.class);
        // 应用侧 MybatisPlusConfig 同款分页插件：selectPage 需要它做 LIMIT 改写与 count
        MybatisPlusInterceptor interceptor = new MybatisPlusInterceptor();
        interceptor.addInnerInterceptor(new PaginationInnerInterceptor(DbType.H2));
        configuration.addInterceptor(interceptor);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        SqlSessionFactory sessionFactory = factory.getObject();
        SqlSessionTemplate session = new SqlSessionTemplate(sessionFactory);
        emailMapper = session.getMapper(EmailMapper.class);
        messageMapper = session.getMapper(EmailMessageMapper.class);
        emailRepository = new EmailRepositoryImpl(emailMapper);
        messageRepository = new EmailMessageRepositoryImpl(messageMapper);
        service = new EmailServiceImpl(emailRepository, messageRepository);
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    // ---------------------------------------------------------------- 投递

    @Test
    @DisplayName("sendMail：首次建箱（雪花 id、状态有效）+ 落一条 PENDING 消息；findById 装载消息")
    void sendMailCreatesMailboxThenLoadsMessages() {
        Result<EmailMessageVO> first = service.sendMail(7L, "第一条",
                new MailSendContext(900L, 100L, 3L));
        assertEquals(1, first.getCode());
        assertEquals(EmailMessage.EMStatus.PENDING, first.getData().getStatus());
        assertNotNull(first.getData().getId(), "消息 id 由服务端雪花生成");
        assertNotNull(first.getData().getEmailId());

        Result<EmailMessageVO> second = service.sendMail(7L, "第二条",
                new MailSendContext(900L, 100L, 3L));
        assertEquals(1, second.getCode());
        assertEquals(first.getData().getEmailId(), second.getData().getEmailId(),
                "同一轮次对同一 Agent 的多封信进入同一邮箱");

        Result<EmailVO> found = service.findById(first.getData().getEmailId());
        assertEquals(1, found.getCode());
        EmailVO vo = found.getData();
        assertEquals(900L, vo.getWorkflowExecutionId());
        assertEquals(7L, vo.getRecipientAgentId());
        assertEquals(3L, vo.getTeamId());
        assertEquals(Email.STATUS_ACTIVE, vo.getStatus());
        assertNotNull(vo.getCreateAt());
        // 单查装载消息，且按 createAt,id 升序 = 写入顺序
        assertNotNull(vo.getMessageVOList());
        assertEquals(2, vo.getMessageVOList().size());
        assertEquals("第一条", vo.getMessageVOList().get(0).getContent());
        assertEquals(100L, vo.getMessageVOList().get(0).getSenderId());
        assertEquals("第二条", vo.getMessageVOList().get(1).getContent());

        assertEquals(1L, emailMapper.selectCount(null).longValue(), "只应有一条邮箱");
        assertEquals(2L, messageMapper.selectCount(null).longValue());

        assertThrows(ClientException.class, () -> service.findById(null));
    }

    @Test
    @DisplayName("sendMail 参数校验：context/toAgentId/content/workflowExecutionId/senderAgentId 缺失即报错")
    void sendMailRejectsIncompleteInput() {
        MailSendContext ok = new MailSendContext(900L, 100L, null);
        assertThrows(ClientException.class, () -> service.sendMail(7L, "x", null));
        assertThrows(ClientException.class, () -> service.sendMail(null, "x", ok));
        assertThrows(ClientException.class, () -> service.sendMail(7L, null, ok));
        assertThrows(ClientException.class, () -> service.sendMail(7L, "  ", ok));
        assertThrows(ClientException.class, () -> service.sendMail(7L, "x", new MailSendContext(null, 100L, null)));
        assertThrows(ClientException.class, () -> service.sendMail(7L, "x", new MailSendContext(900L, null, null)));
        assertEquals(0L, emailMapper.selectCount(null).longValue(), "校验失败不得留下任何邮箱");
    }

    @Test
    @DisplayName("向尚未启动的 Agent 发信：启动时可读；恢复后仍指向同一邮箱，新信继续进该邮箱")
    void mailToNotYetStartedAgentIsReadableAndMailboxStaysStable() {
        // 收件 Agent 7 此刻没有任何执行实例
        service.sendMail(7L, "第一条", new MailSendContext(900L, 100L, 3L));
        service.sendMail(7L, "第二条", new MailSendContext(900L, 100L, 3L));

        List<Email> boxes = List.copyOf(emailRepository.queryByPage(1, 10, null, null).getRecords());
        assertEquals(1, boxes.size());
        Long mailboxId = boxes.get(0).getId();

        // 子执行启动：读到两封
        Result<List<EmailMessageVO>> startupRead = service.consumePending(900L, 7L);
        assertEquals(1, startupRead.getCode());
        assertEquals(2, startupRead.getData().size());
        assertEquals(List.of("第一条", "第二条"),
                startupRead.getData().stream().map(EmailMessageVO::getContent).toList());

        // 暂停恢复后再次读取：同一个邮箱，且不重复投递已消费的消息
        assertTrue(service.consumePending(900L, 7L).getData().isEmpty(), "已消费的消息不得再次交付");
        assertEquals(mailboxId, emailRepository.findByBusinessKey(900L, 7L).orElseThrow().getId(),
                "恢复不改变邮箱归属");

        // 恢复后新到的信仍进同一邮箱
        service.sendMail(7L, "恢复后新到", new MailSendContext(900L, 100L, 3L));
        Result<List<EmailMessageVO>> afterResume = service.consumePending(900L, 7L);
        assertEquals(1, afterResume.getData().size());
        assertEquals(mailboxId, afterResume.getData().get(0).getEmailId());
    }

    // ---------------------------------------------------------------- 隔离

    @Test
    @DisplayName("路由隔离：同轮次不同 Agent、同 Agent 不同轮次的消息互不可见")
    void mailboxRoutingIsolatesByWorkflowAndRecipient() {
        Email sameWorkflowOtherAgent = newEmail(900L, 8L, null);
        Email otherWorkflowSameAgent = newEmail(901L, 7L, null);
        emailRepository.save(sameWorkflowOtherAgent);
        emailRepository.save(otherWorkflowSameAgent);

        Long mine = service.sendMail(7L, "给 900 轮的 7 号", new MailSendContext(900L, 100L, null))
                .getData().getId();
        Long otherAgent = service.addMessage(newMessageCommand(sameWorkflowOtherAgent.getId(), 100L, "给 8 号"))
                .getData().getId();
        Long otherWorkflow = service.addMessage(newMessageCommand(otherWorkflowSameAgent.getId(), 100L, "给 901 轮的 7 号"))
                .getData().getId();

        Result<List<EmailMessageVO>> consumed = service.consumePending(900L, 7L);
        assertEquals(1, consumed.getCode());
        assertEquals(List.of(mine), consumed.getData().stream().map(EmailMessageVO::getId).toList(),
                "只消费 (900, 7) 这一把业务键下的消息");

        assertEquals(EmailMessage.EMStatus.PENDING,
                messageRepository.findById(otherAgent).orElseThrow().getStatus(), "其他 Agent 的消息不受影响");
        assertEquals(EmailMessage.EMStatus.PENDING,
                messageRepository.findById(otherWorkflow).orElseThrow().getStatus(), "其他轮次的消息不受影响");
    }

    @Test
    @DisplayName("consumePending：空邮箱 / 参数为 null 的行为")
    void consumePendingOnEmptyMailbox() {
        assertTrue(service.consumePending(999L, 7L).getData().isEmpty(), "邮箱不存在返回空列表而非报错");
        assertThrows(ClientException.class, () -> service.consumePending(null, 7L));
        assertThrows(ClientException.class, () -> service.consumePending(900L, null));
    }

    @Test
    @DisplayName("consumePending 二次调用：首轮已全部 CONSUMED，再次拉取为空")
    void consumePendingSecondCallReturnsEmpty() {
        service.sendMail(7L, "第一轮", new MailSendContext(900L, 100L, null));

        Result<List<EmailMessageVO>> first = service.consumePending(900L, 7L);
        assertEquals(1, first.getCode());
        assertEquals(1, first.getData().size());

        Result<List<EmailMessageVO>> second = service.consumePending(900L, 7L);
        assertEquals(1, second.getCode());
        assertTrue(second.getData().isEmpty());
    }

    @Test
    @DisplayName("hasPending 只读判定：不改任何消息状态；消费后转空；空邮箱/参数缺失返回 false")
    void hasPendingIsReadOnlyAndDefensive() {
        service.sendMail(7L, "待处理", new MailSendContext(900L, 100L, null));
        Long messageId = service.sendMail(7L, "第二封", new MailSendContext(900L, 100L, null)).getData().getId();

        assertTrue(service.hasPending(900L, 7L), "有 PENDING 消息应返回 true");

        // 判定不得改变任何消息状态：连判两次结论一致，且消息仍是 PENDING（收尾判定只读、不消费）。
        assertTrue(service.hasPending(900L, 7L));
        assertEquals(EmailMessage.EMStatus.PENDING,
                messageRepository.findById(messageId).orElseThrow().getStatus(),
                "只读判定不得把消息判成已消费");

        // 消费之后不再有待处理输入。
        service.consumePending(900L, 7L);
        assertFalse(service.hasPending(900L, 7L), "消费后无 PENDING，返回 false");

        // 空邮箱 / 参数缺失：不报错，返回 false（收尾判定要能安全地空转）。
        assertFalse(service.hasPending(999L, 7L), "邮箱不存在返回 false 而非报错");
        assertFalse(service.hasPending(null, 7L), "参数为 null 返回 false");
        assertFalse(service.hasPending(900L, null), "参数为 null 返回 false");
    }

    // ---------------------------------------------------------------- 并发

    @Test
    @DisplayName("并发首次发信：唯一索引裁决，只创建一条邮箱，且每封信都落库")
    void concurrentFirstSendCreatesExactlyOneMailbox() throws Exception {
        int threads = 6;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch ready = new CountDownLatch(threads);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<Long>> futures = new ArrayList<>();
        try {
            for (int i = 0; i < threads; i++) {
                long senderId = 100L + i;
                futures.add(pool.submit(() -> {
                    ready.countDown();
                    start.await();
                    return service.sendMail(7L, "并发首信-" + senderId,
                            new MailSendContext(900L, senderId, 3L)).getData().getId();
                }));
            }
            ready.await();
            start.countDown();
            for (Future<Long> future : futures) {
                assertNotNull(future.get(30, TimeUnit.SECONDS), "每个线程都必须成功投递");
            }
        } finally {
            pool.shutdownNow();
        }

        assertEquals(1L, emailMapper.selectCount(null).longValue(), "并发首次建箱只能有一条邮箱");
        assertEquals(threads, messageMapper.selectCount(null).intValue(), "每封信都必须落库，一封不丢");

        List<Email> boxes = List.copyOf(emailRepository.queryByPage(1, 10, null, null).getRecords());
        assertEquals(1, boxes.size());
        assertEquals(900L, boxes.get(0).getWorkflowExecutionId());
        assertEquals(7L, boxes.get(0).getRecipientAgentId());
        assertEquals(3L, boxes.get(0).getTeamId());
        assertEquals(threads, messageRepository.findByEmailId(boxes.get(0).getId()).size());
    }

    @Test
    @DisplayName("并发消费：单条消息只成功交付一次，其余竞争者以可重试冲突失败")
    void concurrentConsumeDeliversMessageExactlyOnce() throws Exception {
        Email mailbox = newEmail(900L, 7L, null);
        emailRepository.save(mailbox);
        Long messageId = service.addMessage(newMessageCommand(mailbox.getId(), 100L, "唯一一条"))
                .getData().getId();

        int threads = 6;
        List<EmailMessageVO> delivered = Collections.synchronizedList(new ArrayList<>());
        // 落败线程有两种合法收场，都不能拿到这条消息：
        //   (a) 抢先读到 PENDING，但条件更新生效行数不足 -> ClientException（可重试冲突）；
        //   (b) 赢家提交之后才查收件箱 -> 直接读到空列表，正常返回。
        // 二者比例取决于线程调度，所以只断言「二者之和 = 其余线程数」，不断言各自的具体条数。
        AtomicInteger conflicts = new AtomicInteger();
        AtomicInteger emptyReads = new AtomicInteger();
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch ready = new CountDownLatch(threads);
        CountDownLatch start = new CountDownLatch(1);
        try {
            for (int i = 0; i < threads; i++) {
                pool.submit(() -> {
                    ready.countDown();
                    try {
                        start.await();
                        Result<List<EmailMessageVO>> result = service.consumePending(900L, 7L);
                        if (result.getData().isEmpty()) {
                            emptyReads.incrementAndGet();
                        } else {
                            delivered.addAll(result.getData());
                        }
                    } catch (ClientException e) {
                        conflicts.incrementAndGet();
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                });
            }
            ready.await();
            start.countDown();
            pool.shutdown();
            assertTrue(pool.awaitTermination(30, TimeUnit.SECONDS), "并发消费应在超时前收敛");
        } finally {
            pool.shutdownNow();
        }

        assertEquals(1, delivered.size(), "单条消息只能交付一次");
        assertEquals(messageId, delivered.get(0).getId());
        assertEquals(threads - 1, conflicts.get() + emptyReads.get(),
                "其余竞争者要么以可重试冲突失败，要么读到空收件箱，都不能拿到这条消息");
        assertEquals(EmailMessage.EMStatus.CONSUMED,
                messageRepository.findById(messageId).orElseThrow().getStatus());
    }

    // ---------------------------------------------------------------- 查询

    @Test
    @DisplayName("findPage 过滤分页：收件 Agent / 团队快照组合过滤正确，分页不装载消息（防 N+1）")
    void listPageFiltersByRecipientAndTeam() {
        emailRepository.save(newEmail(900L, 11L, 100L));
        emailRepository.save(newEmail(901L, 11L, 100L));
        emailRepository.save(newEmail(900L, 22L, 100L));

        assertEquals(3L, service.findPage(1, 10, null, null).getData().getTotal().longValue());
        assertEquals(2L, service.findPage(1, 10, 11L, null).getData().getTotal().longValue());
        assertEquals(3L, service.findPage(1, 10, null, 100L).getData().getTotal().longValue());
        assertEquals(2L, service.findPage(1, 10, 11L, 100L).getData().getTotal().longValue());
        assertEquals(0L, service.findPage(1, 10, 22L, 200L).getData().getTotal().longValue());

        List<EmailVO> records = List.copyOf(service.findPage(1, 10, null, null).getData().getRecords());
        assertEquals(3, records.size());
        assertNull(records.get(0).getMessageVOList(), "分页列表不装载消息");
    }

    @Test
    @DisplayName("queryIn：null/空集合返回空列表；仅返回存在的 id 且不装载消息")
    void queryInReturnsOnlyExistingWithoutMessages() {
        Email first = newEmail(900L, 11L, null);
        Email second = newEmail(900L, 22L, 300L);
        emailRepository.save(first);
        emailRepository.save(second);
        service.addMessage(newMessageCommand(first.getId(), 1L, "批量不装载"));
        service.addMessage(newMessageCommand(second.getId(), 2L, "批量不装载二"));

        assertTrue(service.queryIn(null).getData().isEmpty(), "ids 为 null 返回空列表而非报错");
        assertTrue(service.queryIn(List.of()).getData().isEmpty(), "ids 为空集合返回空列表而非报错");

        Long missingId = IdUtil.getSnowflakeNextId();
        Result<List<EmailVO>> mixed = service.queryIn(List.of(first.getId(), missingId));
        assertEquals(1, mixed.getData().size(), "不存在的 id 静默跳过，不整体失败");
        EmailVO only = mixed.getData().get(0);
        assertEquals(first.getId(), only.getId());
        assertEquals(11L, only.getRecipientAgentId());
        assertEquals(900L, only.getWorkflowExecutionId());
        assertNull(only.getMessageVOList(), "批量路径不装载消息（与分页路径语义一致）");

        assertEquals(2, service.queryIn(List.of(first.getId(), second.getId())).getData().size());
    }

    // ---------------------------------------------------------------- 删除

    @Test
    @DisplayName("del 事务内级联：先删该邮箱全部消息再删邮箱；不存在不再幂等成功而是报错")
    void delByIdCascadesMessages() {
        Email prepared = newEmail(900L, 11L, null);
        emailRepository.save(prepared);
        service.addMessage(newMessageCommand(prepared.getId(), 1L, "待删除一"));
        service.addMessage(newMessageCommand(prepared.getId(), 1L, "待删除二"));
        assertEquals(2, messageRepository.findByEmailId(prepared.getId()).size());

        assertEquals(1, service.delById(prepared.getId()).getCode());
        assertTrue(emailRepository.findById(prepared.getId()).isEmpty(), "邮箱本身已删除");
        assertTrue(messageRepository.findByEmailId(prepared.getId()).isEmpty(), "级联消息已删除");
        assertEquals(0L, messageMapper.selectCount(null).longValue(), "消息表无孤儿行");

        assertThrows(ClientException.class, () -> service.delById(prepared.getId()), "删除不存在应报错");
        assertThrows(ClientException.class, () -> service.delById(null), "id 为 null 应报错");
    }

    // ---------------------------------------------------------------- 消息生命周期

    @Test
    @DisplayName("addMessage：邮箱存在才可挂消息，初始 PENDING，雪花 id")
    void addMessageCreatesPendingForExistingEmail() {
        Email prepared = newEmail(900L, 11L, null);
        emailRepository.save(prepared);

        Result<EmailMessageVO> added = service.addMessage(
                newMessageCommand(prepared.getId(), 9L, "你好，请处理"));
        assertEquals(1, added.getCode());
        EmailMessageVO vo = added.getData();
        assertNotNull(vo.getId(), "雪花 id 由服务端生成");
        assertEquals(prepared.getId(), vo.getEmailId());
        assertEquals(9L, vo.getSenderId());
        assertEquals("你好，请处理", vo.getContent());
        assertEquals(EmailMessage.EMStatus.PENDING, vo.getStatus());
        assertNotNull(vo.getCreateAt());

        assertEquals(EmailMessage.EMStatus.PENDING,
                messageRepository.findById(vo.getId()).orElseThrow().getStatus());

        ClientException noEmail = assertThrows(ClientException.class,
                () -> service.addMessage(newMessageCommand(IdUtil.getSnowflakeNextId(), 9L, "悬挂消息")));
        assertEquals("emailId 对应数据不存在", noEmail.getMessage(), "邮箱不存在应拒绝");

        ClientException noContent = assertThrows(ClientException.class,
                () -> service.addMessage(newMessageCommand(prepared.getId(), 9L, " ")));
        assertEquals("content is null", noContent.getMessage(), "空白内容应拒绝");
    }

    @Test
    @DisplayName("listMessages 按 createAt,id 升序返回，与写入顺序一致；无消息返回空列表")
    void listMessagesReturnsAscendingOrder() {
        Email prepared = newEmail(900L, 11L, null);
        emailRepository.save(prepared);

        assertTrue(service.listMessages(prepared.getId()).getData().isEmpty(), "尚无消息时返回空列表而非报错");

        Long id0 = service.addMessage(newMessageCommand(prepared.getId(), 1L, "一")).getData().getId();
        Long id1 = service.addMessage(newMessageCommand(prepared.getId(), 1L, "二")).getData().getId();
        Long id2 = service.addMessage(newMessageCommand(prepared.getId(), 1L, "三")).getData().getId();

        Result<List<EmailMessageVO>> listed = service.listMessages(prepared.getId());
        assertEquals(1, listed.getCode());
        assertEquals(List.of(id0, id1, id2),
                listed.getData().stream().map(EmailMessageVO::getId).toList());
        assertEquals("三", listed.getData().get(2).getContent());

        assertThrows(ClientException.class, () -> service.listMessages(null), "emailId 为 null 应报错");
    }

    @Test
    @DisplayName("updateMessageContent 走领域方法改内容并触碰 updateAt")
    void updateMessageContentRewritesContent() {
        Email prepared = newEmail(900L, 11L, null);
        emailRepository.save(prepared);
        Long messageId = service.addMessage(newMessageCommand(prepared.getId(), 1L, "旧内容"))
                .getData().getId();

        Result<EmailMessageVO> updated = service.updateMessageContent(messageId, "新内容");
        assertEquals(1, updated.getCode());
        assertEquals("新内容", updated.getData().getContent());
        assertNotNull(updated.getData().getUpdateAt());

        assertEquals("新内容", messageRepository.findById(messageId).orElseThrow().getContent());

        assertThrows(ClientException.class,
                () -> service.updateMessageContent(IdUtil.getSnowflakeNextId(), "不存在"), "消息不存在应报错");
        assertThrows(ClientException.class, () -> service.updateMessageContent(messageId, " "), "空白内容应报错");
    }

    @Test
    @DisplayName("consume 条件更新：PENDING→CONSUMED；重复 consume 抛「该消息已消费」")
    void consumeMessageRejectsSecondConsume() {
        Email prepared = newEmail(900L, 11L, null);
        emailRepository.save(prepared);
        Long messageId = service.addMessage(newMessageCommand(prepared.getId(), 1L, "待消费"))
                .getData().getId();

        Result<EmailMessageVO> consumed = service.consumeMessage(messageId);
        assertEquals(1, consumed.getCode());
        assertEquals(EmailMessage.EMStatus.CONSUMED, consumed.getData().getStatus());
        assertNotNull(consumed.getData().getUpdateAt());

        ClientException again = assertThrows(ClientException.class, () -> service.consumeMessage(messageId));
        assertEquals("该消息已消费", again.getMessage(), "重复消费应拒绝");
        assertEquals(EmailMessage.EMStatus.CONSUMED,
                messageRepository.findById(messageId).orElseThrow().getStatus());

        assertThrows(ClientException.class, () -> service.consumeMessage(IdUtil.getSnowflakeNextId()),
                "消息不存在应拒绝消费");
    }

    @Test
    @DisplayName("findByBusinessKeyForUpdate：锁定读可命中业务键（并发回查路径依赖的 SQL 形态）")
    void lockedBusinessKeyReadHitsExistingMailbox() {
        Email prepared = newEmail(900L, 7L, 3L);
        emailRepository.save(prepared);

        Email found = emailRepository.findByBusinessKeyForUpdate(900L, 7L).orElseThrow();
        assertEquals(prepared.getId(), found.getId());
        assertEquals(3L, found.getTeamId());

        assertTrue(emailRepository.findByBusinessKeyForUpdate(900L, 8L).isEmpty(), "未命中返回空");
        assertTrue(emailRepository.findByBusinessKeyForUpdate(null, 7L).isEmpty(), "参数为 null 返回空");
        assertTrue(emailRepository.findByBusinessKeyForUpdate(900L, null).isEmpty(), "参数为 null 返回空");
    }

    // ---------------------------------------------------------------- 测试数据

    /** 测试数据准备：角色邮箱（业务键 = 协作根会话 id + recipientAgentId，状态默认有效）。 */
    private static Email newEmail(Long workflowExecutionId, Long recipientAgentId, Long teamId) {
        return Email.builder()
                .id(IdUtil.getSnowflakeNextId())
                .workflowExecutionId(workflowExecutionId)
                .recipientAgentId(recipientAgentId)
                .teamId(teamId)
                .status(Email.STATUS_ACTIVE)
                .build();
    }

    private static EmailMessageCommand newMessageCommand(Long emailId, Long senderId, String content) {
        EmailMessageCommand command = new EmailMessageCommand();
        command.setEmailId(emailId);
        command.setSenderId(senderId);
        command.setContent(content);
        return command;
    }
}
