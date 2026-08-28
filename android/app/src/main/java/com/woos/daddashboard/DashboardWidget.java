package com.woos.daddashboard;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class DashboardWidget extends AppWidgetProvider {

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        refresh(context, appWidgetManager, appWidgetIds);
    }

    static void refresh(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) renderLoading(context, manager, id);

        new Thread(() -> {
            SharedPreferences prefs = context.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE);
            String authCookie = prefs.getString(MainActivity.KEY_AUTH_COOKIE, "");
            if (authCookie.isEmpty()) {
                for (int id : ids) render(context, manager, id, -1, -1, "앱을 열어 먼저 연결해줘");
                return;
            }

            try {
                JSONObject payload = getTasks(authCookie);
                JSONArray tasks = payload.optJSONArray("tasks");
                int needsCheck = 0;
                int unfinished = 0;
                if (tasks != null) {
                    for (int i = 0; i < tasks.length(); i++) {
                        JSONObject t = tasks.optJSONObject(i);
                        if (t == null) continue;
                        if (t.optBoolean("needsCheck", false)) needsCheck++;
                        if (!"완료".equals(t.optString("status", ""))) unfinished++;
                    }
                }
                for (int id : ids) render(context, manager, id, needsCheck, unfinished, "눌러서 대시보드 열기");
            } catch (Exception e) {
                for (int id : ids) render(context, manager, id, -1, -1, "앱을 열어 다시 연결해줘");
            }
        }).start();
    }

    private static JSONObject getTasks(String authCookie) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(MainActivity.BASE_URL + "/api/tasks").openConnection();
        conn.setRequestMethod("GET");
        conn.setRequestProperty("Cookie", authCookie);
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(10000);
        int code = conn.getResponseCode();
        if (code != 200) throw new IllegalStateException("HTTP " + code);
        StringBuilder sb = new StringBuilder();
        try (BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = br.readLine()) != null) sb.append(line);
        }
        conn.disconnect();
        return new JSONObject(sb.toString());
    }

    private static void renderLoading(Context context, AppWidgetManager manager, int id) {
        render(context, manager, id, -1, -1, "불러오는 중…");
    }

    private static void render(Context context, AppWidgetManager manager, int id,
                               int needsCheck, int unfinished, String footer) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.dashboard_widget);
        views.setTextViewText(R.id.widgetTitle, "아빠 대시보드");
        views.setTextViewText(R.id.needsCheck,
                needsCheck >= 0 ? "🔔 확인필요  " + needsCheck + "건" : "🔔 확인필요  -");
        views.setTextViewText(R.id.unfinished,
                unfinished >= 0 ? "📋 미완료  " + unfinished + "건" : "📋 미완료  -");
        views.setTextViewText(R.id.footer, footer);

        Intent open = new Intent(context, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(context, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        views.setOnClickPendingIntent(R.id.widgetRoot, pi);
        manager.updateAppWidget(id, views);
    }
}
