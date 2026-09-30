package com.piops.management;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication
@ConfigurationPropertiesScan
public class ManagementServerApplication {

    public static void main(String[] args) {
        SpringApplication.run(ManagementServerApplication.class, args);
    }
}
