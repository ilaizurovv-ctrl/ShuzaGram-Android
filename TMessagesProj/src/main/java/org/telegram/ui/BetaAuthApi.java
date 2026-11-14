package org.telegram.ui;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Separate client for ShuzaGram's synthetic beta-only authentication.
 * This does not create or modify a Telegram MTProto authorization.
 */
public final class BetaAuthApi {
    private static final String BASE_URL = "https://shuzagram-beta-auth-a082.onrender.com";

    public interface Callback {
        void onResult(JSONObject result, String error);
    }

    private BetaAuthApi() {
    }

    public static void requestCode(String phone, Callback callback) {
        post("/api/beta-auth/request-code", phone, null, callback);
    }

    public static void verify(String phone, String code, Callback callback) {
        post("/api/beta-auth/verify", phone, code, callback);
    }

    private static void post(String path, String phone, String code, Callback callback) {
        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                URL url = new URL(BASE_URL + path);
                connection = (HttpURLConnection) url.openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(20000);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");

                JSONObject body = new JSONObject();
                body.put("phone", phone);
                if (code != null) {
                    body.put("code", code);
                }
                byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(payload);
                }

                int status = connection.getResponseCode();
                InputStream stream = status >= 200 && status < 300
                        ? connection.getInputStream() : connection.getErrorStream();
                StringBuilder responseText = new StringBuilder();
                if (stream != null) {
                    try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                        String line;
                        while ((line = reader.readLine()) != null) {
                            responseText.append(line);
                        }
                    }
                }
                JSONObject response = responseText.length() == 0 ? new JSONObject() : new JSONObject(responseText.toString());
                if (status >= 200 && status < 300 && response.optBoolean("ok")) {
                    callback.onResult(response, null);
                } else {
                    String error;
                    switch (response.optString("error")) {
                        case "code_rate_limited":
                            error = "Код уже отправлялся. Подождите 60 секунд.";
                            break;
                        case "beta_number_not_found":
                            error = "Этот тестовый номер не найден. Получите номер у @ShuzaGramLoginBot.";
                            break;
                        case "code_expired_or_invalid":
                            error = "Код неверный, уже использован или истёк. Запросите новый код.";
                            break;
                        case "invalid_phone":
                        case "invalid_input":
                            error = "Неверный тестовый номер или код.";
                            break;
                        default:
                            error = "Не удалось связаться с сервером Beta Auth (HTTP " + status + "). Попробуйте позже.";
                            break;
                    }
                    callback.onResult(response, error);
                }
            } catch (Exception e) {
                callback.onResult(new JSONObject(), "Ошибка подключения к серверу Beta Auth. Проверьте интернет и попробуйте снова.");
            } finally {
                if (connection != null) {
                    connection.disconnect();
                }
            }
        }, "ShuzaGramBetaAuth").start();
    }
}
