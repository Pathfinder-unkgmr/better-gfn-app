package com.bettergfn.app;

import android.annotation.SuppressLint;
import android.os.Bundle;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.appcompat.app.AppCompatActivity;
import java.io.InputStream;
import java.util.Scanner;

public class MainActivity extends AppCompatActivity {

    private WebView webView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setDatabaseEnabled(true);
        
        // Improve performance and gaming experience
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage consoleMessage) {
                if (consoleMessage.messageLevel() == android.webkit.ConsoleMessage.MessageLevel.ERROR) {
                    final String msg = "JS Error: " + consoleMessage.message();
                    runOnUiThread(() -> {
                        android.widget.Toast.makeText(MainActivity.this, msg, android.widget.Toast.LENGTH_LONG).show();
                    });
                }
                return super.onConsoleMessage(consoleMessage);
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                injectScript();
            }
        });

        // Set fake user agent to spoof desktop Chrome
        String desktopUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
        settings.setUserAgentString(desktopUA);

        webView.loadUrl("https://play.geforcenow.com/");
    }

    private void injectScript() {
        try {
            InputStream is = getAssets().open("better-gfn.js");
            java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(is));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append("\n");
            }
            is.close();
            
            String js = sb.toString();
            String safeJs = "(function() { try { if (!window.__bgfn_injected) { window.__bgfn_injected = true; \n" + js + "\n } } catch(e) { console.error('BetterGFN Exception: ' + e); } })();";
            
            webView.post(() -> {
                webView.evaluateJavascript(safeJs, value -> {
                    android.widget.Toast.makeText(MainActivity.this, "Script Injection Sent!", android.widget.Toast.LENGTH_SHORT).show();
                });
            });
        } catch (Exception e) {
            final String err = e.getMessage();
            runOnUiThread(() -> {
                android.widget.Toast.makeText(MainActivity.this, "Asset Error: " + err, android.widget.Toast.LENGTH_LONG).show();
            });
            e.printStackTrace();
        }
    }
    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
