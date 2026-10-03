FROM maven:3.9.11-eclipse-temurin-21 AS build

WORKDIR /workspace

COPY pom.xml ./
RUN mvn --batch-mode --no-transfer-progress dependency:go-offline

COPY src ./src
RUN mvn --batch-mode --no-transfer-progress -DskipTests package

FROM eclipse-temurin:21-jre

WORKDIR /app

# Spring 管理面是独立控制面，不携带 Node/Pi Runtime 代码。
COPY --from=build /workspace/target/management-server-0.1.0-SNAPSHOT.jar /app/management-server.jar

EXPOSE 8080

ENTRYPOINT ["java", "-jar", "/app/management-server.jar"]
