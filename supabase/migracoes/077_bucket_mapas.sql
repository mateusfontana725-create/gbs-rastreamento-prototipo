-- Migração 077: bucket público "mapas" para o mapa de ruas gratuito usado sem internet pela página do participante.
--   · Guarda o arquivo parana.pmtiles (recorte do Paraná dos dados do OpenStreetMap, publicado pelo Protomaps).
--   · Público para leitura: o mapa não tem dado pessoal, e o app lê pedaços do arquivo direto do endereço público
--     (/storage/v1/object/public/mapas/parana.pmtiles). Ninguém grava pelo app: o arquivo é enviado pelo painel do Supabase.
--   · Limite de 2 GB por arquivo neste bucket (o limite geral do projeto, em Storage → Settings, também precisa permitir).
-- Sem o arquivo, o app segue com o mapa antigo.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('mapas', 'mapas', true, 2147483648, null)
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = null;

notify pgrst, 'reload schema';
