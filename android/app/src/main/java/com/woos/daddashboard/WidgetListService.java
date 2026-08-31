package com.woos.daddashboard;

import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

public class WidgetListService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Factory(getApplicationContext());
    }

    static class Item {
        final String id;
        final String title;
        final String project;
        final String status;

        Item(String id, String title, String project, String status) {
            this.id = id;
            this.title = title;
            this.project = project;
            this.status = status;
        }
    }

    static class Factory implements RemoteViewsFactory {
        private final Context context;
        private final List<Item> items = new ArrayList<>();

        Factory(Context context) {
            this.context = context;
        }

        @Override public void onCreate() {}

        @Override
        public void onDataSetChanged() {
            items.clear();
            try {
                JSONObject payload = MainActivity.fetchSummary();
                JSONArray arr = payload.optJSONArray("items");
                if (arr == null) return;
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject o = arr.optJSONObject(i);
                    if (o == null) continue;
                    items.add(new Item(
                            o.optString("id", ""),
                            o.optString("title", "(제목 없음)"),
                            o.optString("project", ""),
                            o.optString("status", "")
                    ));
                }
            } catch (Exception ignored) {}
        }

        @Override public void onDestroy() { items.clear(); }
        @Override public int getCount() { return items.size(); }

        @Override
        public RemoteViews getViewAt(int position) {
            if (position < 0 || position >= items.size()) return null;
            Item item = items.get(position);
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_check_item);
            views.setTextViewText(R.id.itemTitle, (position + 1) + ". " + item.title);

            StringBuilder meta = new StringBuilder();
            if (!item.project.isEmpty()) meta.append(item.project);
            if (!item.status.isEmpty()) {
                if (meta.length() > 0) meta.append(" · ");
                meta.append(item.status);
            }
            views.setTextViewText(R.id.itemMeta, meta.toString());

            Intent fill = new Intent();
            fill.putExtra("task_id", item.id);
            fill.putExtra("task_title", item.title);
            views.setOnClickFillInIntent(R.id.itemRoot, fill);
            return views;
        }

        @Override public RemoteViews getLoadingView() { return null; }
        @Override public int getViewTypeCount() { return 1; }
        @Override public long getItemId(int position) { return position; }
        @Override public boolean hasStableIds() { return true; }
    }
}
