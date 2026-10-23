package com.classscoring.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 前台服务保活：APP 被杀时仍保持运行
 * 服务内部定时拉取后端 inbox，收到通知后用 NotificationCompat 弹出
 *
 * 注：Android 14+ 前台服务必须声明 serviceType=dataSync
 * 诊断日志写入 SharedPreferences("push_service_logs")，供 App.jsx 读取显示
 */
public class PushForegroundService extends Service {

    private static final String TAG = "PushFgService";
    private static final String CHANNEL_ID = "push_foreground";
    private static final String ALERT_CHANNEL_ID = "push_alert";
    private static final int NOTIF_ID = 1001;
    // 长轮询：服务端 hold 25s，客户端 connect/read timeout 30s（略大于 hold）
    // 请求返回后立即发起下一次（POLL_INTERVAL_MS 仅用于出错时的退避）
    private static final long POLL_INTERVAL_MS = 3 * 1000;  // 出错退避 3s
    private static final int POLL_CONNECT_TIMEOUT_MS = 30 * 1000;
    private static final int POLL_READ_TIMEOUT_MS = 30 * 1000;
    private static final String POLL_WAIT_SEC = "25";
    private static final int MAX_LOGS = 200;

    private Handler handler;
    private String apiUrl;
    private String memberId;
    private String lastNotifId;
    private Runnable pollRunnable;
    private volatile boolean pollRunning = false;
    private SharedPreferences prefs;
    private SharedPreferences logPrefs;

    @Override
    public void onCreate() {
        super.onCreate();
        handler = new Handler(Looper.getMainLooper());
        prefs = getSharedPreferences("push_service", MODE_PRIVATE);
        logPrefs = getSharedPreferences("push_service_logs", MODE_PRIVATE);
        createNotificationChannel();
        writeLog("Service onCreate, 进程=" + android.os.Process.myPid());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 优先从 intent 取新配置，没有则从 SharedPreferences 恢复（系统重启服务时 intent 为 null）
        if (intent != null && intent.getStringExtra("apiUrl") != null) {
            apiUrl = intent.getStringExtra("apiUrl");
            memberId = intent.getStringExtra("memberId");
            String newLastId = intent.getStringExtra("lastNotifId");
            // intent 传入的 lastNotifId 只在服务首次启动时采用，避免覆盖服务运行中已更新的值
            if (lastNotifId == null && newLastId != null) lastNotifId = newLastId;
            // 持久化保存（系统重启服务后能恢复）
            try {
                prefs.edit()
                        .putString("apiUrl", apiUrl)
                        .putString("memberId", memberId)
                        .putString("lastNotifId", lastNotifId)
                        .apply();
            } catch (Exception e) {}
            writeLog("onStartCommand from intent: apiUrl=" + apiUrl + ", memberId=" + memberId + ", lastNotifId=" + lastNotifId);
        } else if (apiUrl == null) {
            try {
                apiUrl = prefs.getString("apiUrl", null);
                memberId = prefs.getString("memberId", null);
                lastNotifId = prefs.getString("lastNotifId", null);
                writeLog("onStartCommand from SharedPreferences: apiUrl=" + apiUrl + ", memberId=" + memberId + ", lastNotifId=" + lastNotifId);
            } catch (Exception e) {
                writeLog("恢复配置失败: " + e.getMessage());
            }
        }

        Notification notification = buildForegroundNotification();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIF_ID, notification);
            }
        } catch (Exception e) {
            writeLog("startForeground 失败: " + e.getMessage());
        }

        startPolling();
        // START_STICKY: 服务被杀后系统会自动重启
        return START_STICKY;
    }

    private void createNotificationChannel() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        // 保活渠道（低优先级，静默）
        NotificationChannel fgChannel = new NotificationChannel(
                CHANNEL_ID, "推送保活", NotificationManager.IMPORTANCE_LOW);
        fgChannel.setDescription("保持应用接收推送通知");
        fgChannel.setShowBadge(false);
        nm.createNotificationChannel(fgChannel);
        // 推送通知渠道（高优先级，弹窗+振动）
        NotificationChannel alertChannel = new NotificationChannel(
                ALERT_CHANNEL_ID, "推送通知", NotificationManager.IMPORTANCE_HIGH);
        alertChannel.enableVibration(true);
        alertChannel.enableLights(true);
        nm.createNotificationChannel(alertChannel);
    }

    private Notification buildForegroundNotification() {
        // 点击通知打开 MainActivity
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        android.app.PendingIntent pi = android.app.PendingIntent.getActivity(
                this, 0, openIntent, android.app.PendingIntent.FLAG_IMMUTABLE | android.app.PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("班级评分系统")
                .setContentText("正在接收通知（点击打开）")
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setOngoing(true)
                .setContentIntent(pi)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }

    private void startPolling() {
        if (pollRunnable != null) handler.removeCallbacks(pollRunnable);
        pollRunning = true;
        // 长轮询必须串行执行：用单线程 worker 循环，请求完成（hold 最多 25s）后立即发起下一次
        // 出错时 sleep POLL_INTERVAL_MS 退避，避免快速循环
        pollRunnable = new Runnable() {
            @Override
            public void run() {
                writeLog("长轮询已启动，hold=" + POLL_WAIT_SEC + "s，timeout=" + (POLL_READ_TIMEOUT_MS / 1000) + "s");
                new Thread(() -> {
                    while (pollRunning) {
                        boolean ok = pollInboxSync();
                        if (!pollRunning) break;
                        if (!ok) {
                            try { Thread.sleep(POLL_INTERVAL_MS); } catch (InterruptedException ie) { break; }
                        }
                        // 成功时立即发起下一次（无 sleep），让长轮询接管实时性
                    }
                }, "PushPollWorker").start();
            }
        };
        handler.post(pollRunnable);
    }

    /**
     * 同步阻塞拉取 inbox（在 worker 线程中调用）
     * 长轮询：服务端 hold 最多 25s，有新消息立即返回
     * @return true=请求成功（无论有无新消息），false=出错需退避
     */
    private boolean pollInboxSync() {
        if (apiUrl == null || memberId == null) {
            writeLog("pollInbox 跳过：apiUrl 或 memberId 为空");
            return false;
        }
        HttpURLConnection conn = null;
        try {
            String base = apiUrl.replaceAll("/+$", "");
            StringBuilder urlBuilder = new StringBuilder(base)
                    .append("/api/push/inbox/").append(URLEncoder.encode(memberId, "UTF-8"))
                    .append("?wait=").append(POLL_WAIT_SEC);
            if (lastNotifId != null) {
                urlBuilder.append("&since=").append(URLEncoder.encode(lastNotifId, "UTF-8"));
            }
            URL url = new URL(urlBuilder.toString());
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(POLL_CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(POLL_READ_TIMEOUT_MS);
            conn.setRequestMethod("GET");

            int code = conn.getResponseCode();
            if (code == 200) {
                BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                StringBuilder sb = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) sb.append(line);
                reader.close();
                String body = sb.toString();
                JSONObject resp = new JSONObject(body);
                JSONArray notifs = resp.optJSONArray("notifications");
                int count = notifs != null ? notifs.length() : 0;
                if (count > 0) {
                    for (int i = 0; i < count; i++) {
                        JSONObject n = notifs.getJSONObject(i);
                        String id = n.optString("id");
                        String title = n.optString("title", "通知");
                        String text = n.optString("body", "");
                        showLocalNotification(id, title, text);
                        lastNotifId = id;
                    }
                    prefs.edit().putString("lastNotifId", lastNotifId).apply();
                    writeLog("拉取到 " + count + " 条新通知，lastNotifId=" + lastNotifId);
                } else {
                    writeLog("长轮询正常，无新通知");
                }
                return true;
            } else {
                writeLog("轮询 HTTP " + code + ": " + readErrorStream(conn));
                return false;
            }
        } catch (Exception e) {
            writeLog("pollInbox error: " + e.getClass().getSimpleName() + ": " + e.getMessage());
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private String readErrorStream(HttpURLConnection conn) {
        try {
            java.io.InputStream es = conn.getErrorStream();
            if (es == null) return "";
            BufferedReader reader = new BufferedReader(new InputStreamReader(es));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) sb.append(line);
            reader.close();
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private void showLocalNotification(String notifId, String title, String body) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) {
                writeLog("NotificationManager 为空，无法弹通知");
                return;
            }
            // 检查通知权限（Android 13+）
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                int perm = checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS);
                if (perm != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    writeLog("POST_NOTIFICATIONS 权限未授予，通知可能不显示");
                }
            }
            Notification notif = new NotificationCompat.Builder(this, ALERT_CHANNEL_ID)
                    .setContentTitle(title)
                    .setContentText(body)
                    .setSmallIcon(android.R.drawable.ic_dialog_info)
                    .setAutoCancel(true)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                    .build();
            int id = (notifId == null ? 0 : Math.abs(notifId.hashCode()));
            nm.notify(id, notif);
            writeLog("已弹出通知 #" + id + ": " + title);
        } catch (Exception e) {
            writeLog("showLocalNotification error: " + e.getMessage());
        }
    }

    /**
     * 写入诊断日志到 SharedPreferences，供 App.jsx 读取
     * 格式：[时间] 消息
     * 保留最近 MAX_LOGS 条
     */
    private void writeLog(String msg) {
        try {
            String ts = new SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(new Date());
            String line = "[" + ts + "] " + msg;
            Log.w(TAG, line);
            String existing = logPrefs.getString("logs", "");
            String[] lines = existing.split("\n");
            List<String> list = new ArrayList<>();
            for (String l : lines) {
                if (!l.trim().isEmpty()) list.add(l);
            }
            list.add(line);
            // 保留最近 MAX_LOGS 条
            while (list.size() > MAX_LOGS) list.remove(0);
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < list.size(); i++) {
                if (i > 0) sb.append("\n");
                sb.append(list.get(i));
            }
            logPrefs.edit().putString("logs", sb.toString()).putLong("lastUpdate", System.currentTimeMillis()).apply();
        } catch (Exception e) {
            Log.e(TAG, "writeLog error", e);
        }
    }

    @Override
    public void onDestroy() {
        pollRunning = false; // 通知 worker 线程退出循环
        if (pollRunnable != null) handler.removeCallbacks(pollRunnable);
        writeLog("Service onDestroy");
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
