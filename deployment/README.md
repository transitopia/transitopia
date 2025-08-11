## Deployment Notes

Deployment of map data to CloudFlare is done using PMTiles vector map files
hosted on CloudFlare R2 and served using CloudFlare workers, as described in the
PMTiles documentation at https://docs.protomaps.com/deploy/cloudflare

Command to upload the data file:

    cd web-ui/public
    rclone copy transitopia-base-british-columbia.pmtiles transitopia-maps-r2:transitopia-maps --s3-no-check-bucket
    rclone copy transitopia-micromobility-british-columbia.pmtiles transitopia-maps-r2:transitopia-maps --s3-no-check-bucket

The changes will not be visible for a while (4 hours?) unless you purge the cache at
https://dash.cloudflare.com AND view the site in an incognito window.

TODO: maybe put a version string in the filename so it clears the cache better,
and/or so we can have time-travel maps / map history in the future (once map
format is stabilized). https://github.com/transitopia/transitopia/issues/8
