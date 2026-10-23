package com.classscoring.app;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import java.security.MessageDigest;
import cn.jpush.android.api.JPushInterface;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(name = "JPush")
public class JPushPlugin extends Plugin {

    private static final String TAG = "JPushPlugin";

    @Override
    public void load() {
        // JPush SDK 已在 MainApplication.onCreate 中初始化，此处不再重复 init
        Log.w(TAG, "JPushPlugin loaded, package=" + getContext().getPackageName()
                + ", appKey=" + getMetaData("JPUSH_APPKEY"));
    }

    private String getMetaData(String key) {
        try {
            android.content.pm.ApplicationInfo ai = getContext().getPackageManager()
                    .getApplicationInfo(getContext().getPackageName(), android.content.pm.PackageManager.GET_META_DATA);
            Object v = ai.metaData.get(key);
            return v == null ? "null" : v.toString();
        } catch (Exception e) {
            return "err:" + e.getMessage();
        }
    }

    /**
     * 获取 APK 签名的 SHA1/SHA256（debug keystore 签名指纹）
     * 用于核对 JPush 控制台是否填写了正确的应用签名
     */
    private JSObject getSignatureInfo() {
        JSObject sigInfo = new JSObject();
        try {
            Context ctx = getContext();
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(
                    ctx.getPackageName(), PackageManager.GET_SIGNATURES);
            Signature[] sigs = pi.signatures;
            if (sigs == null || sigs.length == 0) {
                sigInfo.put("error", "无签名");
                return sigInfo;
            }
            Signature sig = sigs[0];
            byte[] cert = sig.toByteArray();

            MessageDigest md1 = MessageDigest.getInstance("SHA1");
            md1.update(cert);
            sigInfo.put("sha1", bytesToHex(md1.digest()));

            MessageDigest md256 = MessageDigest.getInstance("SHA256");
            md256.update(cert);
            sigInfo.put("sha256", bytesToHex(md256.digest()));

            MessageDigest md5 = MessageDigest.getInstance("MD5");
            md5.update(cert);
            sigInfo.put("md5", bytesToHex(md5.digest()));
        } catch (Exception e) {
            sigInfo.put("error", e.getMessage());
        }
        return sigInfo;
    }

    private String bytesToHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < bytes.length; i++) {
            sb.append(Integer.toHexString(bytes[i] & 0xFF).toUpperCase());
            if (i < bytes.length - 1) sb.append(":");
        }
        return sb.toString();
    }

    /**
     * 诊断信息：返回 SDK 版本、AppKey、包名、签名指纹、regId 状态
     * 前端调用此方法一次性拿到所有排查信息
     */
    @PluginMethod
    public void getDiagnosticInfo(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            Context ctx = getContext();
            ret.put("packageName", ctx.getPackageName());
            ret.put("appKey", getMetaData("JPUSH_APPKEY"));
            ret.put("channel", getMetaData("JPUSH_CHANNEL"));
            ret.put("regId", JPushInterface.getRegistrationID(ctx));
            ret.put("signature", getSignatureInfo());
            // 检查是否已 init（通过 isPushStopped 判断）
            try {
                ret.put("isPushStopped", JPushInterface.isPushStopped(ctx));
            } catch (Exception e) {
                ret.put("isPushStoppedErr", e.getMessage());
            }
        } catch (Exception e) {
            ret.put("error", e.getMessage());
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void getRegistrationId(PluginCall call) {
        String regId = JPushInterface.getRegistrationID(getContext());
        Log.w(TAG, "getRegistrationId called, regId=" + (regId == null ? "null" : (regId.isEmpty() ? "empty" : regId)));
        if (regId != null && !regId.isEmpty()) {
            JSObject ret = new JSObject();
            ret.put("registrationId", regId);
            call.resolve(ret);
        } else {
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                String retryId = JPushInterface.getRegistrationID(getContext());
                Log.w(TAG, "retry getRegistrationId, regId=" + (retryId == null ? "null" : (retryId.isEmpty() ? "empty" : retryId)));
                if (retryId != null && !retryId.isEmpty()) {
                    JSObject ret = new JSObject();
                    ret.put("registrationId", retryId);
                    call.resolve(ret);
                } else {
                    call.reject("regId empty");
                }
            }, 2000);
        }
    }

    /**
     * 启动前台服务保活（APP 被杀时仍能拉取推送）
     * 参数：apiUrl, memberId, lastNotifId
     */
    @PluginMethod
    public void startForegroundService(PluginCall call) {
        try {
            String apiUrl = call.getString("apiUrl");
            String memberId = call.getString("memberId");
            String lastNotifId = call.getString("lastNotifId");
            if (apiUrl == null || memberId == null) {
                call.reject("apiUrl 和 memberId 必填");
                return;
            }
            Intent intent = new Intent(getContext(), PushForegroundService.class);
            intent.putExtra("apiUrl", apiUrl);
            intent.putExtra("memberId", memberId);
            if (lastNotifId != null) intent.putExtra("lastNotifId", lastNotifId);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
            Log.w(TAG, "ForegroundService started for memberId=" + memberId);
            JSObject ret = new JSObject();
            ret.put("success", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("startForegroundService error: " + e.getMessage());
        }
    }

    /**
     * 停止前台服务
     */
    @PluginMethod
    public void stopForegroundService(PluginCall call) {
        try {
            Intent intent = new Intent(getContext(), PushForegroundService.class);
            getContext().stopService(intent);
            Log.w(TAG, "ForegroundService stopped");
            JSObject ret = new JSObject();
            ret.put("success", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("stopForegroundService error: " + e.getMessage());
        }
    }

    /**
     * 检查电池优化白名单状态
     * 返回 isIgnored=true 表示已加入白名单（不受系统省电限制）
     */
    @PluginMethod
    public void checkBatteryOptimization(PluginCall call) {
        try {
            JSObject ret = new JSObject();
            boolean isIgnored = false;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                android.os.PowerManager pm = (android.os.PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    isIgnored = pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
                }
            }
            ret.put("isIgnored", isIgnored);
            ret.put("sdkInt", Build.VERSION.SDK_INT);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("checkBatteryOptimization error: " + e.getMessage());
        }
    }

    /**
     * 请求加入电池优化白名单（弹出系统对话框）
     */
    @PluginMethod
    public void requestIgnoreBatteryOptimization(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Intent intent = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                intent.setData(android.net.Uri.parse("package:" + getContext().getPackageName()));
                intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
            }
            JSObject ret = new JSObject();
            ret.put("success", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("requestIgnoreBatteryOptimization error: " + e.getMessage());
        }
    }

    /**
     * 跳转到应用详情设置页（权限、自启动等）
     */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Intent intent = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(android.net.Uri.parse("package:" + getContext().getPackageName()));
            intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject ret = new JSObject();
            ret.put("success", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("openAppSettings error: " + e.getMessage());
        }
    }

    /**
     * 跳转到厂商自启动管理页面（小米/华为/OPPO/vivo 等）
     * 各厂商 Intent 常见值，匹配不到则回退到应用详情页
     */
    @PluginMethod
    public void openAutoStartSettings(PluginCall call) {
        try {
            Intent intent = new Intent();
            String brand = Build.BRAND == null ? "" : Build.BRAND.toLowerCase();
            boolean opened = false;

            // 各厂商自启动管理 Intent
            String[][] autoStartIntents = {
                {"xiaomi", "miui.intent.action.OP_AUTO_START"},
                {"xiaomi", "com.miui.permcenter.autostart.AutoStartManagementActivity"},
                {"huawei", "huawei.permission.intent.hw.SPL_APP_MANAGE_PERMISSIONS"},
                {"honor", "huawei.permission.intent.hw.SPL_APP_MANAGE_PERMISSIONS"},
                {"oppo", "com.coloros.safecenter.permission.startup.StartupAppListActivity"},
                {"oppo", "com.coloros.safecenter.permission.startup.FloatingWindowListActivity"},
                {"realme", "com.coloros.safecenter.permission.startup.StartupAppListActivity"},
                {"vivo", "com.iqoo.secure.safeguard.SoftPermissionDetailActivity"},
                {"vivo", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"},
                {"meizu", "com.meizu.safe.security.SHOW_APPSEC"},
                {"samsung", "com.samsung.android.sm.ui.application.AppLockActivity"},
                {"letv", "com.letv.android.letapp.letmanager.LETmanagerActivity"}
            };

            for (String[] entry : autoStartIntents) {
                if (brand.contains(entry[0])) {
                    try {
                        if (entry[1].contains(".")) {
                            intent.setClassName(brand.contains("xiaomi") ? "com.miui.securitycenter"
                                    : brand.contains("huawei") || brand.contains("honor") ? "com.huawei.systemmanager"
                                    : brand.contains("oppo") || brand.contains("realme") ? "com.coloros.safecenter"
                                    : brand.contains("vivo") ? "com.iqoo.secure"
                                    : brand.contains("meizu") ? "com.meizu.safe"
                                    : "", entry[1]);
                        } else {
                            intent.setAction(entry[1]);
                        }
                        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        getContext().startActivity(intent);
                        opened = true;
                        break;
                    } catch (Exception ignored) {}
                }
            }

            // 兜底：跳转到应用详情页
            if (!opened) {
                Intent fallback = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                fallback.setData(android.net.Uri.parse("package:" + getContext().getPackageName()));
                fallback.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
            }

            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("brand", brand);
            ret.put("openedAutoStart", opened);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("openAutoStartSettings error: " + e.getMessage());
        }
    }

    /**
     * 读取前台服务诊断日志（写入 SharedPreferences "push_service_logs"）
     * 返回：logs（日志文本）、lastUpdate（最后更新时间戳）、apiUrl、memberId、lastNotifId
     */
    @PluginMethod
    public void getForegroundServiceLog(PluginCall call) {
        try {
            android.content.SharedPreferences logSp = getContext()
                    .getSharedPreferences("push_service_logs", Context.MODE_PRIVATE);
            android.content.SharedPreferences sp = getContext()
                    .getSharedPreferences("push_service", Context.MODE_PRIVATE);
            JSObject ret = new JSObject();
            ret.put("logs", logSp.getString("logs", ""));
            ret.put("lastUpdate", logSp.getLong("lastUpdate", 0));
            ret.put("apiUrl", sp.getString("apiUrl", null));
            ret.put("memberId", sp.getString("memberId", null));
            ret.put("lastNotifId", sp.getString("lastNotifId", null));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("getForegroundServiceLog error: " + e.getMessage());
        }
    }

    /**
     * 清空前台服务诊断日志
     */
    @PluginMethod
    public void clearForegroundServiceLog(PluginCall call) {
        try {
            getContext().getSharedPreferences("push_service_logs", Context.MODE_PRIVATE)
                    .edit().clear().apply();
            JSObject ret = new JSObject();
            ret.put("success", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("clearForegroundServiceLog error: " + e.getMessage());
        }
    }
}
