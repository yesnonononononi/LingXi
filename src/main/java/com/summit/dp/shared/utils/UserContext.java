package com.summit.dp.shared.utils;

import com.summit.dp.service.domain.exception.ClientException;
import com.summit.dp.service.domain.model.auth.AuthSession;
import lombok.Data;
import org.springframework.lang.NonNull;


@Data
public class UserContext {

    private static  ThreadLocal<AuthSession> authSession = new ThreadLocal<>();

    public static void set(AuthSession a){
        if(a == null){
            throw new ClientException("未获取到用户信息");
        }
         authSession.set(a);
    }

    public static @NonNull AuthSession get(){
        return authSession.get();
    }

    public static void clear() {
        authSession.remove();
    }
}
