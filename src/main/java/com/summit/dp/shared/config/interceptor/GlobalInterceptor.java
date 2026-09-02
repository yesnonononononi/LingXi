package com.summit.dp.shared.config.interceptor;

import cn.hutool.core.util.StrUtil;
import com.summit.dp.auth.application.service.AuthCacheProvider;
import com.summit.dp.auth.domain.model.AuthSession;
import com.summit.dp.shared.utils.JwtUtils;
import com.summit.dp.shared.utils.UserContext;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.jspecify.annotations.NonNull;
import org.jspecify.annotations.Nullable;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;


@RequiredArgsConstructor
@Component
public class GlobalInterceptor implements HandlerInterceptor {
    private final AuthCacheProvider authCacheProvider;

    @Override
    public boolean preHandle(@NonNull HttpServletRequest request, @NonNull HttpServletResponse response, @NonNull Object handler) {
        //1,获取并解析token
        String authorization = request.getHeader("Authorization");
        if(StrUtil.isBlank(authorization) || !authorization.startsWith("Bearer "))  return unAuthorization(response);
        String token = authorization.substring("Bearer ".length());
        if(StrUtil.isBlank(token))  return unAuthorization(response);

        //1.1,Token是否有效
        if(isValid(token)){

            //1.2,解析token
            try {
                AuthSession authSession = JwtUtils.resolveToken(token);
                authSession.setToken(token);
                //2,存入上下文
                UserContext.set(authSession);
                return true;
            } catch (Exception e) {
                return unAuthorization(response);
            }
        }
        return unAuthorization(response);
    }
    @Override
    public void afterCompletion(@NonNull HttpServletRequest request, @NonNull HttpServletResponse response, @NonNull Object handler, @Nullable Exception ex)  {
        UserContext.clear();
    }

    private boolean isValid(String token) {
        return (!authCacheProvider.isExist(token));

    }


    private boolean unAuthorization(HttpServletResponse response){
        response.setStatus(401);
        return false;
    }

}
