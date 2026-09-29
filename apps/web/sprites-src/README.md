# Sprites (icons) for Transitopia map

To convert these into the raster sprite format that MapLibreGL needs, run these
command **from the `web-ui` folder**:

```
docker run -v ./sprites-src:/app/sprites-src -v ./public:/app/public  -w /app ghcr.io/flother/spreet:0.12.1 --unique sprites-src public/transitopia-sprites

docker run -v ./sprites-src:/app/sprites-src -v ./public:/app/public  -w /app ghcr.io/flother/spreet:0.12.1 --retina --unique sprites-src public/transitopia-sprites@2x
```

This will update the `transitopia-sprites*` files in `web-ui/public/`.
