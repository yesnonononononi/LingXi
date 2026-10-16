package com.summit.dp.sandbox_security.domain.model;

import com.summit.core.runtime.security.SecurityAction;

/** 规则是集合内的值对象；预设标记只用于展示，不授予额外权限。 */
public record SecurityRule(String pattern, String matchType, SecurityAction read,
                           SecurityAction write, SecurityAction delete, SecurityAction action,
                           boolean enabled, String preset) { }
