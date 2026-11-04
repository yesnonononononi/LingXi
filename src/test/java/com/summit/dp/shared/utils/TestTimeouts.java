package com.summit.dp.shared.utils;

/**
 * 测试侧时间闸门的<b>单一真源</b>：这些常量只用来「防挂死」，<b>绝不能当性能断言</b>。
 *
 * <h2>为什么要专门建一个常量类：绝对秒数当性能闸门是设计缺陷</h2>
 *
 * <p>历史上 {@code src/test/**} 里散着 29 处 {@code @Timeout(<字面量>)}（13 个类），
 * 本意是「用例不许永远挂住」，但在实际使用中兼职成了「这个用例必须在 N 秒内跑完」的性能断言。
 * 这两件事的判据完全不同：防挂死的阈值要远比正常耗时宽松（差一个数量级也不过分），
 * 而「机器多快」根本不是被测代码的属性。<b>把机器速度写进断言，就会把环境波动判成代码缺陷。</b></p>
 *
 * <h2>实测证据（同一条用例、同一份 diff，前一次绿后一次红）</h2>
 *
 * <ul>
 *   <li>Backend CI run 41778867571（head {@code fc778881}）：
 *       {@code ExecutionCleanupFileStorageTest.cleanupKeepsReferencedHistoryAndCommitsPerExecution}
 *       用 <b>30.16s</b> 通过 —— 而当时它挂的是 {@code @Timeout(60)}（正是本类要消灭的字面量形式），
 *       余量只有 2 倍。</li>
 *   <li>Backend CI run 41782431227（<b>同一 head</b>）：同一条用例
 *       {@code » Timeout … timed out after 60 seconds}，停在 {@code ExecutionCleanupFileStorageTest.java:68}
 *       （240 行逐条 insert 的循环里），实测 <b>60.05s</b> 超时。<b>代码没变，是 runner 变慢了。</b></li>
 *   <li>同一时间段 69 个可比测试类合计耗时 <b>462.2s → 609.4s（1.32×）</b>；
 *       DB 重的 {@code ExecutionCleanupTest} <b>50.71s → 99.59s（1.96×）</b>；
 *       Maven {@code Total time} <b>09:14 → 12:20</b>。</li>
 *   <li><b>在本机（快机、同一份代码）单跑这两个类</b>：
 *       {@code ExecutionCleanupFileStorageTest} 已经要 <b>50.32s</b>、
 *       {@code ExecutionCleanupCursorProbeTest} 要 <b>56.48s</b> —— 也就是说 60s 的闸门在本机
 *       已经被吃掉 <b>84%</b>，CI 慢 1.3–2 倍就必然超时。</li>
 * </ul>
 *
 * <p>也就是说：一条本来绿的用例，在机器慢 2 倍时会随机变红，而且红的信息是
 * 「超时」，完全指不到任何代码问题。修法不是把 60 改成 300 了事（那只是把随机红的概率往下压），
 * 而是把职责拆开：<b>这里的常量只防挂死</b>；
 * 「清理是否退化成 O(n²)」这类性能回归用<b>自校准的相对增长守卫</b>来守
 * （见 {@code ExecutionCleanupFileStorageTest}/{@code ExecutionCleanupCursorProbeTest}
 * 里的四分位守卫：容器慢只等比放大两边，比值不变）。</p>
 *
 * <p>一句话结论：<b>绝对秒数闸门测的是 runner 的磁盘速度，不是代码正确性。</b>
 * 「本机已占 84% 预算」和「环境波动 1.96×」这两个数，比任何「理论上可能抖动」的说法都硬。</p>
 *
 * <h2>取值依据</h2>
 *
 * <ul>
 *   <li>{@link #HANG_GUARD} = 300s：改造前非限堆用例里最大的字面量是 240s，取 300s 保证
 *       <b>每个用例的语义都不弱于原值</b>（全部 ≥ 原值）；同时约为最慢实测（本机 50.32s）
 *       的 6 倍 —— runner 再慢半个数量级也不会误杀，真挂死仍会在 CI 作业超时前被杀掉。</li>
 *   <li>{@link #LONG_HANG_GUARD} = 600s：留给要起子 JVM / 限堆（{@code -Xmx512m}）的用例，
 *       它们本身就要跑一次完整保存流程，慢机器的放大效应最明显；沿用改造前
 *       {@code LimitedHeapCheckpointOomTest} 的 600s，语义不变。</li>
 * </ul>
 *
 * <p><b>不许为了「让它绿」把这些常量调小。</b>这正是本次缺陷的翻版（把闸门往后挪一点点，
 * 下次环境波动再红）。下限由 {@code TestTimeoutRatchetTest} 的棘轮断言守住：
 * {@code HANG_GUARD >= 240}、{@code LONG_HANG_GUARD >= HANG_GUARD}，
 * 并且 {@code src/test/**} 里禁止再出现 {@code @Timeout(<数字>)} 字面量。</p>
 *
 * <h2>为什么是 {@code static final long} 字面量</h2>
 *
 * <p>JUnit 5 的 {@code @Timeout#value} 是注解成员，实参必须是<b>编译期常量</b>，
 * 所以只能是 {@code static final long = <字面量>}，不能改成从配置读（那会编译不过）。
 * 副作用：改动常量会触发引用方重新编译 —— 这是好事，避免「改了常量但旧 class 还在跑旧值」。</p>
 */
public final class TestTimeouts {

    /**
     * 普适用例的防挂死上限（秒）：只保证用例不会永远挂住，<b>不是</b>性能断言。
     *
     * <p>取值 300s：≥ 改造前所有非限堆字面量（30/60/90/120/240），且约为最慢实测（30.16s）的 10 倍。</p>
     */
    public static final long HANG_GUARD = 300L;

    /**
     * 限堆 / 子进程 / OOM 类用例的防挂死上限（秒）：这类用例要起子 JVM，慢机器放大效应最大。
     *
     * <p>取值 600s：与改造前 {@code LimitedHeapCheckpointOomTest} 的字面量一致，语义不变。</p>
     */
    public static final long LONG_HANG_GUARD = 600L;

    private TestTimeouts() {
    }
}
