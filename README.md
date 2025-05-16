# PinguShell WebSocket Client

VPS üzerinde çalışan ve PinguShell ile iletişimi sağlayan WebSocket istemcisi.

## Özellikler

- Supabase Realtime API ile gerçek zamanlı komut alışverişi
- VPS'nin sistem durumunu paylaşma
- Shell komutlarını güvenli şekilde çalıştırma
- Otomatik bağlantı yönetimi

## Kurulum

```bash
# Bağımlılıkları yükle
bun install

# .env.example dosyasını .env olarak kopyala ve düzenle
cp .env.example .env

# Geliştirme modunda başlat
bun run dev

# Üretim için başlat
bun run start
```

## Ortam Değişkenleri

Aşağıdaki ortam değişkenlerini `.env` dosyasında tanımlamanız gerekiyor:

- `TOKEN`: Kurulum betiği tarafından alınan token
- `GITHUB_NAME`: Github kullanıcı adı
- `SERVER_URL`: PinguShell ana sunucu URL'i
- `ENDPOINT_URL`: WebSocket endpoint URL'i
- `SUPABASE_URL`: Supabase URL'i
- `SUPABASE_KEY`: Supabase Anon Key

## Komut API'leri

- `GET /`: Temel bilgi
- `GET /health`: Sağlık durumu

## Lisans

MIT
