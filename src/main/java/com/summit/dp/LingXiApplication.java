package com.summit.dp;

import com.summit.dp.shared.config.LocalDevelopmentLauncher;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.system.ApplicationHome;
@SpringBootApplication
public class LingXiApplication {

    public static void main(String[] args) {
        SpringApplication application = new SpringApplication(LingXiApplication.class);
        LocalDevelopmentLauncher.configure(application, new ApplicationHome(LingXiApplication.class).getSource());
        application.run(args);
    }

}
