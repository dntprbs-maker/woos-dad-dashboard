package com.woos.daddashboard;

import android.app.Activity;
import android.app.AlertDialog;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.text.InputType;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.Toast;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {
    static final String BASE_URL = "https://woos-dad-dashboard.vercel.app";
    static final String PREFS = "dad_dashboard_prefs";
    static final String KEY_PASSWORD = "dashboard_password";

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        setContentView(webView, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setBuiltInZoomControls(false);
        webView.setWebViewClient(new WebViewClient());

        String savedPassword = getSharedPreferences(PREFS, MODE_PRIVATE)
                .getString(KEY_PASSWORD, "");
        if (savedPassword.isEmpty()) {
            askPassword();
        } else {
            authenticateAndOpen(savedPassword, false);
        }
    }

    private void askPassword() {
        final EditText input = new EditText(this);
        input.setHint("대시보드 비밀번호");
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        int pad = (int) (20 * getResources().getDisplayMetrics().density);
        input.setPadding(pad, pad / 2, pad, pad / 2);

        new AlertDialog.Builder(this)
                .setTitle("아빠 대시보드 연결")
                .setMessage("처음 한 번만 비밀번호를 입력하면 앱과 위젯에서 같이 사용해요.")
                .setView(input)
                .setCancelable(false)
                .setPositiveButton("연결", (d, w) -> {
                    String pw = input.getText().toString();
                    if (pw.isEmpty()) {
                        Toast.makeText(this, "비밀번호를 입력해줘", Toast.LENGTH_SHORT).show();
                        askPassword();
                    } else {
                        authenticateAndOpen(pw, true);
                    }
                })
                .show();
    }

    private void authenticateAndOpen(String password, boolean saveOnSuccess) {
        new Thread(() -> {
            try {
                URL url = new URL(BASE_URL + "/api/login");
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setDoOutput(true);
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(10000);
                String body = "{\"password\":\"" + escapeJson(password) + "\"}";
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(body.getBytes(StandardCharsets.UTF_8));
                }

                int code = conn.getResponseCode();
                String cookie = conn.getHeaderField("Set-Cookie");
                conn.disconnect();

                runOnUiThread(() -> {
                    if (code == 200 && cookie != null) {
                        if (saveOnSuccess) {
                            getSharedPreferences(PREFS, MODE_PRIVATE)
                                    .edit().putString(KEY_PASSWORD, password).apply();
                        }
                        CookieManager.getInstance().setAcceptCookie(true);
                        CookieManager.getInstance().setCookie(BASE_URL, cookie);
                        CookieManager.getInstance().flush();
                        webView.loadUrl(BASE_URL);
                        refreshWidgets(this);
                    } else {
                        getSharedPreferences(PREFS, MODE_PRIVATE)
                                .edit().remove(KEY_PASSWORD).apply();
                        Toast.makeText(this, "비밀번호를 다시 확인해줘", Toast.LENGTH_LONG).show();
                        askPassword();
                    }
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    Toast.makeText(this, "연결 실패: " + e.getMessage(), Toast.LENGTH_LONG).show();
                    webView.loadUrl(BASE_URL);
                });
            }
        }).start();
    }

    static void refreshWidgets(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ComponentName component = new ComponentName(context, DashboardWidget.class);
        int[] ids = manager.getAppWidgetIds(component);
        if (ids.length > 0) {
            DashboardWidget.refresh(context, manager, ids);
        }
    }

    static String escapeJson(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }
}
