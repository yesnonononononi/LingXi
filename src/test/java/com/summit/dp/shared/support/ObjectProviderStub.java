package com.summit.dp.shared.support;

import org.springframework.beans.BeansException;
import org.springframework.beans.factory.ObjectProvider;

import java.util.Iterator;
import java.util.List;

/**
 * 测试用 {@link ObjectProvider} 桩：按给定顺序原样提供实例，不启动容器。
 *
 * <p>被测类用 {@code ObjectProvider} 是为了断开启动期循环依赖，用例里不需要容器，
 * 但确实要验「按 order 串行调用」「单个失败不影响后续」这类顺序语义，所以给个最小替身。</p>
 */
public final class ObjectProviderStub<T> implements ObjectProvider<T> {

    private final List<T> values;

    private ObjectProviderStub(List<T> values) {
        this.values = List.copyOf(values);
    }

    public static <T> ObjectProvider<T> of(List<T> values) {
        return new ObjectProviderStub<>(values);
    }

    @Override
    public T getObject() throws BeansException {
        if (values.isEmpty()) {
            throw new IllegalStateException("测试桩里没有可提供的实例");
        }
        return values.getFirst();
    }

    @Override
    public T getObject(Object... args) throws BeansException {
        return getObject();
    }

    @Override
    public T getIfAvailable() throws BeansException {
        return values.isEmpty() ? null : values.getFirst();
    }

    @Override
    public T getIfUnique() throws BeansException {
        return values.size() == 1 ? values.getFirst() : null;
    }

    @Override
    public Iterator<T> iterator() {
        return values.iterator();
    }

    @Override
    public java.util.stream.Stream<T> stream() {
        return values.stream();
    }
}
