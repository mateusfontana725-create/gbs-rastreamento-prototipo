package br.gbs.rastreamento.civil;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

// App do participante (civil): abre a mesma página do link (capacitor.config.json → server.url).
// O GPS em segundo plano vem do plugin @capacitor-community/background-geolocation; a página usa
// o plugin pelo app-android.js (site). Aqui só tratamos o convite e a permissão de notificação.
public class MainActivity extends BridgeActivity {

    private static final int PEDIDO_NOTIFICACAO = 1001;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        abrirConvite(getIntent());
        pedirNotificacoes();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        abrirConvite(intent);
    }

    // gbscivil://abrir?t=<convite>[&s=<sessão>] → <página do civil>?t=<convite>[#s=<sessão>]
    // (o parâmetro "a" muda a cada abertura para a página carregar de novo, mesmo com o mesmo convite)
    // A sessão vem do navegador depois do cadastro e vai no fragmento (#), que não é enviado ao servidor.
    private void abrirConvite(Intent intent) {
        if (intent == null || intent.getData() == null) return;
        Uri dado = intent.getData();
        if (!"gbscivil".equals(dado.getScheme())) return;
        String token = dado.getQueryParameter("t");
        if (token == null || !token.matches("[0-9a-fA-F]{64}")) return;
        String base = getBridge().getServerUrl();
        if (base == null) return;
        Uri.Builder destino = Uri.parse(base).buildUpon().clearQuery().fragment(null)
            .appendQueryParameter("t", token.toLowerCase())
            .appendQueryParameter("a", String.valueOf(System.currentTimeMillis()));
        String sessao = dado.getQueryParameter("s");
        if (sessao != null && sessao.matches("[A-Za-z0-9_-]+")) destino.encodedFragment("s=" + sessao);
        Uri pagina = destino.build();
        getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(pagina.toString()));
    }

    // Android 13+: sem esta permissão a notificação "Rastreamento ativo" não aparece
    private void pedirNotificacoes() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        ActivityCompat.requestPermissions(this, new String[] { Manifest.permission.POST_NOTIFICATIONS }, PEDIDO_NOTIFICACAO);
    }
}
