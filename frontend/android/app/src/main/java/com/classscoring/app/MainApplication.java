package com.classscoring.app;

import android.app.Application;
import android.util.Log;
import cn.jpush.android.api.JPushInterface;

/**
 * 自定义 Application
 * 关键：JPush SDK 必须在 Application.onCreate 中初始化，
 * 不能在 Capacitor Plugin 的 load() 中初始化（懒加载时机太晚），
 * 否则 SDK 内部状态机异常，永远拿不到 registrationID。
 */
public class MainApplication extends Application {

    private static final String TAG = "MainApplication";

    @Override
    public void onCreate() {
        super.onCreate();
        // JPush 初始化（必须在 Application 启动时执行）
        JPushInterface.setDebugMode(true);
        JPushInterface.init(this);
        Log.w(TAG, "JPush SDK initialized in Application.onCreate, package=" + getPackageName()
                + ", appKey=" + getAppKeyFromManifest());
    }

    private String getAppKeyFromManifest() {
        try {
            android.content.pm.ApplicationInfo ai = getPackageManager()
                    .getApplicationInfo(getPackageName(), android.content.pm.PackageManager.GET_META_DATA);
            Object v = ai.metaData.get("JPUSH_APPKEY");
            return v == null ? "null" : v.toString();
        } catch (Exception e) {
            return "err:" + e.getMessage();
        }
    }
}
