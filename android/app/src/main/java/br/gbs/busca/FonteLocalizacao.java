package br.gbs.busca;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationAvailability;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import com.google.android.gms.tasks.CancellationTokenSource;

/**
 * Leituras do GPS do aparelho, uma por segundo (como o watchPosition da página com alta precisão).
 * Usa o serviço de localização do Google quando existe (combina GPS, Wi-Fi e sensores); sem ele, o GPS do Android.
 */
abstract class FonteLocalizacao {

  interface Ouvinte {
    void leitura(Location l);
    /** "indisponivel" (localização do celular desligada), "negado" (sem permissão) ou "ok" (voltou). */
    void situacao(String s);
  }

  static final long INTERVALO_MS = 1000;

  abstract String nome();
  abstract void iniciar(Looper looper, Ouvinte o);
  abstract void parar();

  static boolean temPermissao(Context c) {
    return ContextCompat.checkSelfPermission(c, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
  }

  static boolean localizacaoLigada(Context c) {
    LocationManager lm = (LocationManager) c.getSystemService(Context.LOCATION_SERVICE);
    if (lm == null) return false;
    if (Build.VERSION.SDK_INT >= 28) return lm.isLocationEnabled();
    return lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
  }

  static boolean temGoogle(Context c) {
    try {
      return GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(c) == ConnectionResult.SUCCESS;
    } catch (Throwable t) {
      return false;
    }
  }

  static FonteLocalizacao criar(Context c) {
    return temGoogle(c) ? new Google(c) : new Android(c);
  }

  interface Resposta { void posicao(Location l, int erro); }

  /** Uma leitura agora (para a tela inicial). erro: 1 sem permissão, 2 localização desligada, 3 sem sinal no tempo. */
  @SuppressLint("MissingPermission")
  static void atual(Context c, long tempoMs, Resposta r) {
    Handler h = new Handler(Looper.getMainLooper());
    if (!temPermissao(c)) { h.post(() -> r.posicao(null, 1)); return; }
    if (!localizacaoLigada(c)) { h.post(() -> r.posicao(null, 2)); return; }
    final boolean[] feito = { false };
    Runnable tempo = () -> { if (!feito[0]) { feito[0] = true; r.posicao(null, 3); } };
    h.postDelayed(tempo, tempoMs);
    if (temGoogle(c)) {
      CancellationTokenSource cts = new CancellationTokenSource();
      LocationServices.getFusedLocationProviderClient(c).getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, cts.getToken())
          .addOnCompleteListener(t -> {
            if (feito[0]) return;
            Location l = t.isSuccessful() ? t.getResult() : null;
            if (l == null) return;   // espera o tempo limite
            feito[0] = true;
            h.removeCallbacks(tempo);
            r.posicao(l, 0);
          });
      h.postDelayed(cts::cancel, tempoMs);
      return;
    }
    LocationManager lm = (LocationManager) c.getSystemService(Context.LOCATION_SERVICE);
    LocationListener ll = new LocationListener() {
      @Override public void onLocationChanged(@NonNull Location l) {
        lm.removeUpdates(this);
        if (feito[0]) return;
        feito[0] = true;
        h.removeCallbacks(tempo);
        r.posicao(l, 0);
      }
      @Override public void onStatusChanged(String p, int s, Bundle b) { }
      @Override public void onProviderEnabled(@NonNull String p) { }
      @Override public void onProviderDisabled(@NonNull String p) { }
    };
    lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 0, 0, ll, Looper.getMainLooper());
    h.postDelayed(() -> lm.removeUpdates(ll), tempoMs);
  }

  /* -------------------------------------------------------------- */
  static final class Google extends FonteLocalizacao {
    private final Context c;
    private final FusedLocationProviderClient cliente;
    private LocationCallback cb;

    Google(Context c) { this.c = c; cliente = LocationServices.getFusedLocationProviderClient(c); }

    @Override String nome() { return "google"; }

    @SuppressLint("MissingPermission")
    @Override void iniciar(Looper looper, Ouvinte o) {
      LocationRequest req = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, INTERVALO_MS)
          .setMinUpdateIntervalMillis(INTERVALO_MS)
          .setWaitForAccurateLocation(false)
          .build();
      cb = new LocationCallback() {
        @Override public void onLocationResult(@NonNull LocationResult r) {
          for (Location l : r.getLocations()) o.leitura(l);
        }
        @Override public void onLocationAvailability(@NonNull LocationAvailability a) {
          if (!a.isLocationAvailable() && !localizacaoLigada(c)) o.situacao("indisponivel");
          else if (a.isLocationAvailable()) o.situacao("ok");
        }
      };
      try {
        cliente.requestLocationUpdates(req, cb, looper);
      } catch (SecurityException e) {
        o.situacao("negado");
      }
    }

    @Override void parar() { if (cb != null) cliente.removeLocationUpdates(cb); cb = null; }
  }

  /* -------------------------------------------------------------- */
  static final class Android extends FonteLocalizacao {
    private final LocationManager lm;
    private LocationListener ll;

    Android(Context c) { lm = (LocationManager) c.getSystemService(Context.LOCATION_SERVICE); }

    @Override String nome() { return "android"; }

    @SuppressLint("MissingPermission")
    @Override void iniciar(Looper looper, Ouvinte o) {
      ll = new LocationListener() {
        @Override public void onLocationChanged(@NonNull Location l) { o.leitura(l); }
        @Override public void onStatusChanged(String p, int s, Bundle b) { }
        @Override public void onProviderEnabled(@NonNull String p) { o.situacao("ok"); }
        @Override public void onProviderDisabled(@NonNull String p) { o.situacao("indisponivel"); }
      };
      String prov = lm.getAllProviders().contains(LocationManager.GPS_PROVIDER) ? LocationManager.GPS_PROVIDER : LocationManager.NETWORK_PROVIDER;
      try {
        lm.requestLocationUpdates(prov, INTERVALO_MS, 0, ll, looper);
      } catch (SecurityException e) {
        o.situacao("negado");
      }
    }

    @Override void parar() { if (ll != null) lm.removeUpdates(ll); ll = null; }
  }
}
