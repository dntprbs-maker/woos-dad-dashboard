package com.woos.daddashboard;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class MainActivity extends Activity {
    static final String BASE_URL = "https://woos-dad-dashboard.vercel.app";

    private TextView needsCheckView;
    private TextView unfinishedView;
    private TextView statusView;
    private ProgressBar progress;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
        loadSummary();
        refreshWidgets(this);
    }

    private void buildUi() {
        float d = getResources().getDisplayMetrics().density;
        int pad = (int) (24 * d);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(pad, pad, pad, pad);
        root.setGravity(Gravity.TOP);

        TextView title = new TextView(this);
        title.setText("아빠 대시보드");
        title.setTextSize(28);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        root.addView(title);

        TextView sub = new TextView(this);
        sub.setText("홈 화면 위젯과 같은 요약 정보를 보여줘요.");
        sub.setTextSize(14);
        sub.setPadding(0, (int)(8*d), 0, (int)(24*d));
        root.addView(sub);

        needsCheckView = makeMetric("🔔 확인필요  -");
        unfinishedView = makeMetric("📋 미완료  -");
        root.addView(needsCheckView);
        root.addView(unfinishedView);

        progress = new ProgressBar(this);
        LinearLayout.LayoutParams pp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        pp.gravity = Gravity.CENTER_HORIZONTAL;
        pp.topMargin = (int)(18*d);
        root.addView(progress, pp);

        statusView = new TextView(this);
        statusView.setText("불러오는 중…");
        statusView.setGravity(Gravity.CENTER_HORIZONTAL);
        statusView.setTextSize(13);
        statusView.setPadding(0, (int)(10*d), 0, (int)(20*d));
        root.addView(statusView);

        Button refresh = new Button(this);
        refresh.setText("새로고침");
        refresh.setOnClickListener(v -> loadSummary());
        root.addView(refresh, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        Button full = new Button(this);
        full.setText("전체 대시보드 열기");
        LinearLayout.LayoutParams fp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        fp.topMargin = (int)(10*d);
        full.setOnClickListener(v -> {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(BASE_URL));
            startActivity(intent);
        });
        root.addView(full, fp);

        TextView note = new TextView(this);
        note.setText("※ 앱과 위젯은 비밀번호 없이 건수만 확인해요. 작업 제목·설명 등 전체 내용은 기존 웹 대시보드의 보안을 그대로 유지합니다.");
        note.setTextSize(12);
        note.setPadding(0, (int)(22*d), 0, 0);
        root.addView(note);

        setContentView(root);
    }

    private TextView makeMetric(String text) {
        float d = getResources().getDisplayMetrics().density;
        TextView v = new TextView(this);
        v.setText(text);
        v.setTextSize(22);
        v.setTypeface(null, android.graphics.Typeface.BOLD);
        v.setPadding(0, (int)(10*d), 0, (int)(10*d));
        return v;
    }

    private void loadSummary() {
        progress.setVisibility(View.VISIBLE);
        statusView.setText("불러오는 중…");

        new Thread(() -> {
            try {
                JSONObject payload = fetchSummary();
                int needsCheck = payload.optInt("needsCheck", -1);
                int unfinished = payload.optInt("unfinished", -1);
                runOnUiThread(() -> {
                    progress.setVisibility(View.GONE);
                    needsCheckView.setText("🔔 확인필요  " + needsCheck + "건");
                    unfinishedView.setText("📋 미완료  " + unfinished + "건");
                    statusView.setText("최신 상태");
                    refreshWidgets(this);
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    progress.setVisibility(View.GONE);
                    statusView.setText("불러오지 못했어요");
                    Toast.makeText(this, "연결 실패: " + e.getMessage(), Toast.LENGTH_LONG).show();
                });
            }
        }).start();
    }

    static JSONObject fetchSummary() throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(BASE_URL + "/api/widget-summary").openConnection();
        conn.setRequestMethod("GET");
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
        JSONObject payload = new JSONObject(sb.toString());
        if (!payload.optBoolean("ok", false)) throw new IllegalStateException("summary unavailable");
        return payload;
    }

    static void refreshWidgets(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ComponentName component = new ComponentName(context, DashboardWidget.class);
        int[] ids = manager.getAppWidgetIds(component);
        if (ids.length > 0) DashboardWidget.refresh(context, manager, ids);
    }
}
