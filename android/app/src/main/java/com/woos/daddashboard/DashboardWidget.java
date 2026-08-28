package com.woos.daddashboard;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

import org.json.JSONObject;

public class DashboardWidget extends AppWidgetProvider {

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        refresh(context, appWidgetManager, appWidgetIds);
    }

    static void refresh(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) render(context, manager, id, -1, -1, "불러오는 중…");

        new Thread(() -> {
            try {
                JSONObject payload = MainActivity.fetchSummary();
                int needsCheck = payload.optInt("needsCheck", -1);
                int unfinished = payload.optInt("unfinished", -1);
                for (int id : ids) render(context, manager, id, needsCheck, unfinished, "눌러서 요약 열기");
            } catch (Exception e) {
                for (int id : ids) render(context, manager, id, -1, -1, "새로고침 실패");
            }
        }).start();
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
