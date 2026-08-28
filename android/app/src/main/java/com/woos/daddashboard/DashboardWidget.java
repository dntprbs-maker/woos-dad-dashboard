package com.woos.daddashboard;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.widget.RemoteViews;

import org.json.JSONObject;

public class DashboardWidget extends AppWidgetProvider {

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        refresh(context, appWidgetManager, appWidgetIds);
    }

    static void refresh(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) render(context, manager, id, -1, "불러오는 중…");

        new Thread(() -> {
            try {
                JSONObject payload = MainActivity.fetchSummary();
                int needsCheck = payload.optInt("needsCheck", -1);
                for (int id : ids) {
                    render(context, manager, id, needsCheck, "목록을 위아래로 스크롤할 수 있어요");
                    manager.notifyAppWidgetViewDataChanged(id, R.id.checkList);
                }
            } catch (Exception e) {
                for (int id : ids) render(context, manager, id, -1, "새로고침 실패");
            }
        }).start();
    }

    private static void render(Context context, AppWidgetManager manager, int id,
                               int needsCheck, String footer) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.dashboard_widget);
        views.setTextViewText(R.id.widgetTitle, "아빠 대시보드");
        views.setTextViewText(R.id.needsCheck,
                needsCheck >= 0 ? "🔔 확인필요  " + needsCheck + "건" : "🔔 확인필요  -");
        views.setTextViewText(R.id.footer, footer);

        Intent serviceIntent = new Intent(context, WidgetListService.class);
        serviceIntent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id);
        serviceIntent.setData(Uri.parse(serviceIntent.toUri(Intent.URI_INTENT_SCHEME)));
        views.setRemoteAdapter(R.id.checkList, serviceIntent);
        views.setEmptyView(R.id.checkList, R.id.emptyView);

        Intent open = new Intent(context, MainActivity.class);
        PendingIntent openTemplate = PendingIntent.getActivity(
                context,
                id,
                open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE
        );
        views.setPendingIntentTemplate(R.id.checkList, openTemplate);

        PendingIntent openHeader = PendingIntent.getActivity(
                context,
                id + 10000,
                new Intent(context, MainActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        views.setOnClickPendingIntent(R.id.widgetTitle, openHeader);
        views.setOnClickPendingIntent(R.id.needsCheck, openHeader);

        manager.updateAppWidget(id, views);
    }
}
