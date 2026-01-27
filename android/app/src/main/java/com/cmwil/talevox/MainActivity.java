package com.cmwil.talevox;

import android.content.Intent;
import android.util.Log;
import android.os.Bundle;
import android.os.Build;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginHandle;
import com.cmwil.talevox.jobrunner.JobRunnerPlugin;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import android.content.pm.PackageManager;

import android.Manifest;
import ee.forgr.capacitor.social.login.GoogleProvider;
import ee.forgr.capacitor.social.login.SocialLoginPlugin;
import ee.forgr.capacitor.social.login.ModifiedMainActivityForSocialLoginPlugin;

// ModifiedMainActivityForSocialLoginPlugin is VERY VERY important !!!!!!
public class MainActivity extends BridgeActivity implements ModifiedMainActivityForSocialLoginPlugin {
  private static final int REQ_POST_NOTIFICATIONS = 1001;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    registerPlugin(JobRunnerPlugin.class);

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
          != PackageManager.PERMISSION_GRANTED) {
        ActivityCompat.requestPermissions(
          this,
          new String[]{Manifest.permission.POST_NOTIFICATIONS},
          REQ_POST_NOTIFICATIONS
        );
      }
    }
  }

  @Override
  public void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);

    if (requestCode >= GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MIN
        && requestCode < GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MAX) {

      PluginHandle pluginHandle = getBridge().getPlugin("SocialLogin");
      if (pluginHandle == null) {
        Log.i("Google Activity Result", "SocialLogin login handle is null");
        return;
      }

      Plugin plugin = pluginHandle.getInstance();
      if (!(plugin instanceof SocialLoginPlugin)) {
        Log.i("Google Activity Result", "SocialLogin plugin instance is not SocialLoginPlugin");
        return;
      }

      ((SocialLoginPlugin) plugin).handleGoogleLoginIntent(requestCode, data);
    }
  }

  // This function will never be called, leave it empty
  @Override
  public void IHaveModifiedTheMainActivityForTheUseWithSocialLoginPlugin() {}
}
