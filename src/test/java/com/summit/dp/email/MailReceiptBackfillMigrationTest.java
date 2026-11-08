package com.summit.dp.email;

import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.email.application.service.impl.EmailServiceImpl;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.email.domain.model.Email;
import com.summit.dp.email.domain.model.EmailMessage;
import com.summit.dp.email.domain.repository.EmailMessageReceiptRepository;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMapper;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMessageMapper;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMessageReceiptMapper;
import com.summit.dp.email.infrastructure.repository.EmailMessageReceiptRepositoryImpl;
import com.summit.dp.email.infrastructure.repository.EmailMessageRepositoryImpl;
import com.summit.dp.email.infrastructure.repository.EmailRepositoryImpl;
import com.summit.dp.shared.config.H2SchemaInitializer;
import com.summit.dp.shared.persistence.schema.SchemaScript;
import com.summit.dp.shared.support.H2TestDatabase;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;

import java.time.Instant;
import java.util.Comparator;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 真实升级迁移：V1..V6 建库 → 塞旧数据 → 跑全量（V7 生效）。
 *
 * <p>回填依据只有一条持久事实：迁移这一刻 {@code status = 'CONSUMED'}。版本表保证 V7 只执行一次，
 * 所以「迁移之后才被置为 CONSUMED 且没有回执」的邮件不会被回填 —— 它仍然必须被投递一次。</p>
 */
class MailReceiptBackfillMigrationTest {

    private static final long SESSION_ID = 810L;
    private static final long AGENT_ID = 7L;
    private static final long MAILBOX_ID = 6101L;
    private static final long OLD_CONSUMED_MESSAGE_ID = 8_000_000_000_000_001L;
    private static final long OLD_PENDING_MESSAGE_ID = 8_000_000_000_000_002L;

    /**
     * 升级基线：回填用例先建到该版本，再跑全量脚本模拟一次真实升级。
     *
     * <p>**这是唯一允许写死的版本号**，且它的含义是「V7 回填脚本之前的最后一条」——
     * 也就是本用例的场景定义本身，不是「一共要执行几条」这种会随脚本增加而失效的期望值。</p>
     */
    private static final int BASELINE_VERSION = 6;

    @Test
    @DisplayName("V7 只回填迁移时已存在的 CONSUMED 历史：旧邮件不重放，之后新清理的仍投递一次")
    void upgradeBackfillsOnlyHistoricalConsumedMail() {
        try (H2TestDatabase database = H2TestDatabase.createWithoutSchema("mail-backfill-migration")) {
            H2SchemaInitializer initializer = new H2SchemaInitializer();
            List<SchemaScript> upToV6 = initializer.loadScripts().stream()
                    .filter(script -> script.version() <= 6).toList();
            assertEquals(6, upToV6.size(), "升级用例必须先停在 V6（V7 还没生效）");
            initializer.initialize(database, upToV6);

            seedLegacyMail(database);

            // 升级：跑全量脚本（V7 在这时生效并回填）。
            initializer.initialize(database);

            EmailService emails = service(database);
            assertTrue(emails.pendingItemsUndelivered(SESSION_ID, AGENT_ID).stream()
                            .noneMatch(item -> OLD_CONSUMED_MESSAGE_ID == item.getId()),
                    "迁移前已消费的历史邮件必须按已投递处理，普通新 chat / 旧检查点都不许重放");
            assertEquals(List.of(OLD_CONSUMED_MESSAGE_ID),
                    List.copyOf(receipts(database).findMessageIdsWithReceipt(List.of(OLD_CONSUMED_MESSAGE_ID))),
                    "回填必须留下一条已交付回执");

            // 旧检查点：执行属性里没有任何投递记录，同样不许重放。
            assertTrue(service(database).pendingItemsUndelivered(SESSION_ID, AGENT_ID).stream()
                            .noneMatch(item -> OLD_CONSUMED_MESSAGE_ID == item.getId()),
                    "判据是回执，不依赖执行私有属性");

            // 迁移之后才被清理（status → CONSUMED）且没有回执：必须仍投递一次。
            EmailMessageRepositoryImpl messages = new EmailMessageRepositoryImpl(
                    mapper(database, EmailMessageMapper.class));
            messages.consumeByIds(List.of(OLD_PENDING_MESSAGE_ID));
            assertTrue(receipts(database).findMessageIdsWithReceipt(List.of(OLD_PENDING_MESSAGE_ID)).isEmpty(),
                    "清理只是展示态，不得凭空生成回执");
            List<EmailMessageVO> afterCleanup = service(database).pendingItemsUndelivered(SESSION_ID, AGENT_ID);
            assertEquals(List.of(OLD_PENDING_MESSAGE_ID),
                    afterCleanup.stream().map(EmailMessageVO::getId).toList(),
                    "迁移后才被清理、且没有回执的邮件仍必须被投递一次（窗口不丢输入）");
        }
    }

    @Test
    @DisplayName("重跑建库脚本不会重复回填：版本表只执行一次，回填幂等")
    void reinitializingDoesNotBackfillTwice() {
        try (H2TestDatabase database = H2TestDatabase.createWithoutSchema("mail-backfill-idempotent")) {
            H2SchemaInitializer initializer = new H2SchemaInitializer();
            List<SchemaScript> allScripts = initializer.loadScripts();
            initializer.initialize(database, upTo(allScripts, BASELINE_VERSION));
            seedLegacyMail(database);

            // 期望值从 db/h2 目录自身推导，不写死数字：基线之上有几条脚本，第一次升级就必须
            // 执行几条。新增 V9/V10 时本用例无需改动，而「漏执行」（数量变少）与
            // 「重复执行」（第二次不再是 0）仍然会被抓住。
            List<String> expectedUpgradeScripts = allScripts.stream()
                    .filter(script -> script.version() > BASELINE_VERSION)
                    .sorted(Comparator.comparingInt(SchemaScript::version))
                    .map(SchemaScript::filename)
                    .toList();
            assertFalse(expectedUpgradeScripts.isEmpty(),
                    "基线 V" + BASELINE_VERSION + " 之上必须至少还有一条脚本，否则本用例失去意义");

            int firstRun = initializer.initialize(database);
            int secondRun = initializer.initialize(database);
            assertEquals(expectedUpgradeScripts.size(), firstRun,
                    "第一次升级必须把基线之上的全部脚本各执行一次: " + expectedUpgradeScripts);
            assertEquals(0, secondRun, "再次启动不应重复执行任何脚本");

            // 集合级断言：比数字更能定位问题——少一个名字就是漏执行，多一个就是重复执行/跳版本。
            assertEquals(expectedUpgradeScripts, upgradedScripts(database),
                    "版本表里登记的升级脚本必须与 db/h2 目录里基线之上的脚本完全一致");

            SqlSessionFactory factory = database.sessionFactory(EmailMapper.class, EmailMessageMapper.class,
                    EmailMessageReceiptMapper.class);
            SqlSessionTemplate session = H2TestDatabase.sqlSession(factory);
            assertEquals(1L, session.getMapper(EmailMessageReceiptMapper.class)
                            .selectCount(null).longValue(),
                    "回填幂等：重跑不会多出一条回执");
        }
    }

    /**
     * 版本表里已登记的、基线之上的脚本文件名（按版本升序）。
     *
     * <p>直接查 {@code schema_version} 而不是依赖 {@code initialize} 的返回值：
     * 返回值只是条数，分不清「少执行了哪一条」，也无法区分「漏执行」与「重复执行同一版本」。</p>
     *
     * @param database 目标库
     * @return 脚本文件名清单
     */
    private static List<String> upgradedScripts(H2TestDatabase database) {
        return database.queryColumn("SELECT script FROM schema_version WHERE version > "
                + BASELINE_VERSION + " ORDER BY version");
    }

    /**
     * 取版本号不超过上限的脚本（用于先建到基线、再模拟一次真实升级）。
     *
     * @param scripts 全部脚本
     * @param baselineVersion 基线版本号
     * @return 基线及以下的脚本
     */
    private static List<SchemaScript> upTo(List<SchemaScript> scripts, int baselineVersion) {
        return scripts.stream().filter(script -> script.version() <= baselineVersion).toList();
    }

    /** 迁移前的历史数据：一封已消费（旧版已投递过）、一封仍未读。 */
    private void seedLegacyMail(H2TestDatabase database) {
        EmailRepositoryImpl mailboxes = new EmailRepositoryImpl(mapper(database, EmailMapper.class));
        mailboxes.save(Email.builder().id(MAILBOX_ID).workflowExecutionId(SESSION_ID)
                .recipientAgentId(AGENT_ID).status(Email.STATUS_ACTIVE).build());
        EmailMessageRepositoryImpl messages = new EmailMessageRepositoryImpl(mapper(database, EmailMessageMapper.class));
        messages.save(message(OLD_CONSUMED_MESSAGE_ID, EmailMessage.EMStatus.CONSUMED, "旧版已消费且无回执"));
        messages.save(message(OLD_PENDING_MESSAGE_ID, EmailMessage.EMStatus.PENDING, "旧版还没读"));
    }

    private EmailMessage message(long id, EmailMessage.EMStatus status, String content) {
        return EmailMessage.builder().id(id).emailId(MAILBOX_ID).senderId(8L).content(content)
                .status(status).createAt(Instant.now()).build();
    }

    private EmailService service(H2TestDatabase database) {
        return new EmailServiceImpl(new EmailRepositoryImpl(mapper(database, EmailMapper.class)),
                new EmailMessageRepositoryImpl(mapper(database, EmailMessageMapper.class)), receipts(database));
    }

    private EmailMessageReceiptRepository receipts(H2TestDatabase database) {
        return new EmailMessageReceiptRepositoryImpl(mapper(database, EmailMessageReceiptMapper.class), new MailClaimLivenessFake());
    }

    private <T> T mapper(H2TestDatabase database, Class<T> mapperType) {
        SqlSessionFactory factory = database.sessionFactory(EmailMapper.class, EmailMessageMapper.class,
                EmailMessageReceiptMapper.class);
        return H2TestDatabase.sqlSession(factory).getMapper(mapperType);
    }
}
