/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2019 New Vector Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

'use strict';

import Promise from 'bluebird';
import extend from './extend';
import dis from './dispatcher';
import MatrixClientPeg from './MatrixClientPeg';
import sdk from './index';
import { _t } from './languageHandler';
import Modal from './Modal';
import RoomViewStore from './stores/RoomViewStore';

import encrypt from "browser-encrypt-attachment";

// Polyfill for Canvas.toBlob API using Canvas.toDataURL
import "blueimp-canvas-to-blob";

const MAX_WIDTH = 800;
const MAX_HEIGHT = 600;


/**
 * Create a thumbnail for a image DOM element.
 * The image will be smaller than MAX_WIDTH and MAX_HEIGHT.
 * The thumbnail will have the same aspect ratio as the original.
 * Draws the element into a canvas using CanvasRenderingContext2D.drawImage
 * Then calls Canvas.toBlob to get a blob object for the image data.
 *
 * Since it needs to calculate the dimensions of the source image and the
 * thumbnailed image it returns an info object filled out with information
 * about the original image and the thumbnail.
 *
 * @param {HTMLElement} element The element to thumbnail.
 * @param {integer} inputWidth The width of the image in the input element.
 * @param {integer} inputHeight the width of the image in the input element.
 * @param {String} mimeType The mimeType to save the blob as.
 * @return {Promise} A promise that resolves with an object with an info key
 *  and a thumbnail key.
 */
function createThumbnail(element, inputWidth, inputHeight, mimeType) {
    const deferred = Promise.defer();

    let targetWidth = inputWidth;
    let targetHeight = inputHeight;
    if (targetHeight > MAX_HEIGHT) {
        targetWidth = Math.floor(targetWidth * (MAX_HEIGHT / targetHeight));
        targetHeight = MAX_HEIGHT;
    }
    if (targetWidth > MAX_WIDTH) {
        targetHeight = Math.floor(targetHeight * (MAX_WIDTH / targetWidth));
        targetWidth = MAX_WIDTH;
    }

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    canvas.getContext("2d").drawImage(element, 0, 0, targetWidth, targetHeight);
    canvas.toBlob(function(thumbnail) {
        deferred.resolve({
            info: {
                thumbnail_info: {
                    w: targetWidth,
                    h: targetHeight,
                    mimetype: thumbnail.type,
                    size: thumbnail.size,
                },
                w: inputWidth,
                h: inputHeight,
            },
            thumbnail: thumbnail,
        });
    }, mimeType);

    return deferred.promise;
}

/**
 * Load a file into a newly created image element.
 *
 * @param {File} imageFile The file to load in an image element.
 * @return {Promise} A promise that resolves with the html image element.
 */
function loadImageElement(imageFile) {
    const deferred = Promise.defer();

    // Load the file into an html element
    const img = document.createElement("img");
    const objectUrl = URL.createObjectURL(imageFile);
    img.src = objectUrl;

    // Once ready, create a thumbnail
    img.onload = function() {
        URL.revokeObjectURL(objectUrl);
        deferred.resolve(img);
    };
    img.onerror = function(e) {
        deferred.reject(e);
    };

    return deferred.promise;
}

/**
 * Read the metadata for an image file and create and upload a thumbnail of the image.
 *
 * @param {MatrixClient} matrixClient A matrixClient to upload the thumbnail with.
 * @param {String} roomId The ID of the room the image will be uploaded in.
 * @param {File} imageFile The image to read and thumbnail.
 * @return {Promise} A promise that resolves with the attachment info.
 */
function infoForImageFile(matrixClient, roomId, imageFile) {
    let thumbnailType = "image/png";
    if (imageFile.type == "image/jpeg") {
        thumbnailType = "image/jpeg";
    }

    let imageInfo;
    return loadImageElement(imageFile).then(function(img) {
        return createThumbnail(img, img.width, img.height, thumbnailType);
    }).then(function(result) {
        imageInfo = result.info;
        return uploadFile(matrixClient, roomId, result.thumbnail);
    }).then(function(result) {
        imageInfo.thumbnail_url = result.url;
        imageInfo.thumbnail_file = result.file;
        return imageInfo;
    });
}

/**
 * Load a file into a newly created video element.
 *
 * @param {File} videoFile The file to load in an video element.
 * @return {Promise} A promise that resolves with the video image element.
 */
function loadVideoElement(videoFile) {
    const deferred = Promise.defer();

    // Load the file into an html element
    const video = document.createElement("video");

    const reader = new FileReader();
    reader.onload = function(e) {
        video.src = e.target.result;

        // Once ready, returns its size
        // Wait until we have enough data to thumbnail the first frame.
        video.onloadeddata = function() {
            deferred.resolve(video);
        };
        video.onerror = function(e) {
            deferred.reject(e);
        };
    };
    reader.onerror = function(e) {
        deferred.reject(e);
    };
    reader.readAsDataURL(videoFile);

    return deferred.promise;
}

/**
 * Read the metadata for a video file and create and upload a thumbnail of the video.
 *
 * @param {MatrixClient} matrixClient A matrixClient to upload the thumbnail with.
 * @param {String} roomId The ID of the room the video will be uploaded to.
 * @param {File} videoFile The video to read and thumbnail.
 * @return {Promise} A promise that resolves with the attachment info.
 */
function infoForVideoFile(matrixClient, roomId, videoFile) {
    const thumbnailType = "image/jpeg";

    let videoInfo;
    return loadVideoElement(videoFile).then(function(video) {
        return createThumbnail(video, video.videoWidth, video.videoHeight, thumbnailType);
    }).then(function(result) {
        videoInfo = result.info;
        return uploadFile(matrixClient, roomId, result.thumbnail);
    }).then(function(result) {
        videoInfo.thumbnail_url = result.url;
        videoInfo.thumbnail_file = result.file;
        return videoInfo;
    });
}

/**
 * Read the file as an ArrayBuffer.
 * @param {File} file The file to read
 * @return {Promise} A promise that resolves with an ArrayBuffer when the file
 *   is read.
 */
function readFileAsArrayBuffer(file) {
    const deferred = Promise.defer();
    const reader = new FileReader();
    reader.onload = function(e) {
        deferred.resolve(e.target.result);
    };
    reader.onerror = function(e) {
        deferred.reject(e);
    };
    reader.readAsArrayBuffer(file);
    return deferred.promise;
}

/**
 * Upload the file to the content repository.
 * If the room is encrypted then encrypt the file before uploading.
 *
 * @param {MatrixClient} matrixClient The matrix client to upload the file with.
 * @param {String} roomId The ID of the room being uploaded to.
 * @param {File} file The file to upload.
 * @param {Function?} progressHandler optional callback to be called when a chunk of
 *    data is uploaded.
 * @return {Promise} A promise that resolves with an object.
 *  If the file is unencrypted then the object will have a "url" key.
 *  If the file is encrypted then the object will have a "file" key.
 */
function uploadFile(matrixClient, roomId, file, progressHandler) {
    if (matrixClient.isRoomEncrypted(roomId)) {
        // If the room is encrypted then encrypt the file before uploading it.
        // First read the file into memory.
        return readFileAsArrayBuffer(file).then(function(data) {
            // Then encrypt the file.
            return encrypt.encryptAttachment(data);
        }).then(function(encryptResult) {
            // Record the information needed to decrypt the attachment.
            const encryptInfo = encryptResult.info;
            // Pass the encrypted data as a Blob to the uploader.
            const blob = new Blob([encryptResult.data]);
            return matrixClient.uploadContent(blob, {
                progressHandler: progressHandler,
                includeFilename: false,
            }).then(function(url) {
                // If the attachment is encrypted then bundle the URL along
                // with the information needed to decrypt the attachment and
                // add it under a file key.
                encryptInfo.url = url;
                if (file.type) {
                    encryptInfo.mimetype = file.type;
                }
                return {"file": encryptInfo};
            });
        });
    } else {
        const basePromise = matrixClient.uploadContent(file, {
            progressHandler: progressHandler,
        });
        const promise1 = basePromise.then(function(url) {
            // If the attachment isn't encrypted then include the URL directly.
            return {"url": url};
        });
        // XXX: copy over the abort method to the new promise
        promise1.abort = basePromise.abort;
        return promise1;
    }
}

export default class ContentMessages {
    constructor() {
        this.inprogress = [];
        this.nextId = 0;
        this._mediaConfig = null;
    }

    static sharedInstance() {
        if (global.mx_ContentMessages === undefined) {
            global.mx_ContentMessages = new ContentMessages();
        }
        return global.mx_ContentMessages;
    }

    _isFileSizeAcceptable(file) {
        if (this._mediaConfig !== null &&
            this._mediaConfig["m.upload.size"] !== undefined &&
            file.size > this._mediaConfig["m.upload.size"]) {
            return false;
        }
        return true;
    }

    _ensureMediaConfigFetched() {
        if (this._mediaConfig !== null) return;

        console.log("[Media Config] Fetching");
        return MatrixClientPeg.get().getMediaConfig().then((config) => {
            console.log("[Media Config] Fetched config:", config);
            return config;
        }).catch(() => {
            // Media repo can't or won't report limits, so provide an empty object (no limits).
            console.log("[Media Config] Could not fetch config, so not limiting uploads.");
            return {};
        }).then((config) => {
            this._mediaConfig = config;
        });
    }

    sendStickerContentToRoom(url, roomId, info, text, matrixClient) {
        return MatrixClientPeg.get().sendStickerMessage(roomId, url, info, text).catch((e) => {
            console.warn(`Failed to send content with URL ${url} to room ${roomId}`, e);
            throw e;
        });
    }

    getUploadLimit() {
        if (this._mediaConfig !== null && this._mediaConfig["m.upload.size"] !== undefined) {
            return this._mediaConfig["m.upload.size"];
        }
    }

    async sendContentListToRoom(files, roomId, matrixClient) {
        if (matrixClient.isGuest()) {
            dis.dispatch({action: 'require_registration'});
            return;
        }

        const isQuoting = Boolean(RoomViewStore.getQuotingEvent());
        if (isQuoting) {
            const QuestionDialog = sdk.getComponent("dialogs.QuestionDialog");
            const shouldUpload = await new Promise((resolve) => {
                Modal.createTrackedDialog('Upload Reply Warning', '', QuestionDialog, {
                    title: _t('Replying With Files'),
                    description: (
                        <div>{_t(
                            'At this time it is not possible to reply with a file ' +
                            'so this will be sent without being a reply.',
                        )}</div>
                    ),
                    hasCancelButton: true,
                    button: _t("Continue"),
                    onFinished: (shouldUpload) => {
                        resolve(shouldUpload);
                    },
                });
            });
            if (!shouldUpload) return;
        }

        await this._ensureMediaConfigFetched();

        const tooBigFiles = [];
        const okFiles = [];

        for (let i = 0; i < files.length; ++i) {
            if (this._isFileSizeAcceptable(files[i])) {
                okFiles.push(files[i]);
            } else {
                tooBigFiles.push(files[i]);
            }
        }

        if (tooBigFiles.length > 0) {
            const UploadFailureDialog = sdk.getComponent("dialogs.UploadFailureDialog");
            const uploadFailureDialogPromise = new Promise((resolve) => {
                Modal.createTrackedDialog('Upload Failure', '', UploadFailureDialog, {
                    badFiles: tooBigFiles,
                    totalFiles: files.length,
                    contentMessages: this,
                    onFinished: (shouldContinue) => {
                        resolve(shouldContinue);
                    },
                });
            });
            const shouldContinue = await uploadFailureDialogPromise;
            if (!shouldContinue) return;
        }

        const UploadConfirmDialog = sdk.getComponent("dialogs.UploadConfirmDialog");
        for (let i = 0; i < okFiles.length; ++i) {
            const file = okFiles[i];
            const shouldContinue = await new Promise((resolve) => {
                Modal.createTrackedDialog('Upload Files confirmation', '', UploadConfirmDialog, {
                    file,
                    currentIndex: i,
                    totalFiles: okFiles.length,
                    onFinished: (shouldContinue) => {
                        resolve(shouldContinue);
                    },
                });
            });
            if (!shouldContinue) break;
            this._sendContentToRoom(file, roomId, matrixClient);
        }
    }

    _sendContentToRoom(file, roomId, matrixClient) {
        const content = {
            body: file.name || 'Attachment',
            info: {
                size: file.size,
            },
        };

        // if we have a mime type for the file, add it to the message metadata
        if (file.type) {
            content.info.mimetype = file.type;
        }

        const def = Promise.defer();
        if (file.type.indexOf('image/') == 0) {
            content.msgtype = 'm.image';
            infoForImageFile(matrixClient, roomId, file).then((imageInfo)=>{
                extend(content.info, imageInfo);
                def.resolve();
            }, (error)=>{
                console.error(error);
                content.msgtype = 'm.file';
                def.resolve();
            });
        } else if (file.type.indexOf('audio/') == 0) {
            content.msgtype = 'm.audio';
            def.resolve();
        } else if (file.type.indexOf('video/') == 0) {
            content.msgtype = 'm.video';
            infoForVideoFile(matrixClient, roomId, file).then((videoInfo)=>{
                extend(content.info, videoInfo);
                def.resolve();
            }, (error)=>{
                content.msgtype = 'm.file';
                def.resolve();
            });
        } else {
            content.msgtype = 'm.file';
            def.resolve();
        }

        const upload = {
            fileName: file.name || 'Attachment',
            roomId: roomId,
            total: 0,
            loaded: 0,
        };
        this.inprogress.push(upload);
        dis.dispatch({action: 'upload_started'});

        let error;

        function onProgress(ev) {
            upload.total = ev.total;
            upload.loaded = ev.loaded;
            dis.dispatch({action: 'upload_progress', upload: upload});
        }

        return def.promise.then(function() {
            // XXX: upload.promise must be the promise that
            // is returned by uploadFile as it has an abort()
            // method hacked onto it.
            upload.promise = uploadFile(
                matrixClient, roomId, file, onProgress,
            );
            return upload.promise.then(function(result) {
                content.file = result.file;
                content.url = result.url;
            });
        }).then(function(url) {
            return matrixClient.sendMessage(roomId, content);
        }, function(err) {
            error = err;
            if (!upload.canceled) {
                let desc = _t("The file '%(fileName)s' failed to upload.", {fileName: upload.fileName});
                if (err.http_status == 413) {
                    desc = _t(
                        "The file '%(fileName)s' exceeds this homeserver's size limit for uploads",
                        {fileName: upload.fileName},
                    );
                }
                const ErrorDialog = sdk.getComponent("dialogs.ErrorDialog");
                Modal.createTrackedDialog('Upload failed', '', ErrorDialog, {
                    title: _t('Upload Failed'),
                    description: desc,
                });
            }
        }).finally(() => {
            const inprogressKeys = Object.keys(this.inprogress);
            for (let i = 0; i < this.inprogress.length; ++i) {
                const k = inprogressKeys[i];
                if (this.inprogress[k].promise === upload.promise) {
                    this.inprogress.splice(k, 1);
                    break;
                }
            }
            if (error) {
                // 413: File was too big or upset the server in some way:
                // clear the media size limit so we fetch it again next time
                // we try to upload
                if (error && error.http_status === 413) {
                    this._mediaConfig = null;
                }
                dis.dispatch({action: 'upload_failed', upload, error});
            } else {
                dis.dispatch({action: 'upload_finished', upload});
                dis.dispatch({action: 'message_sent'});
            }
        });
    }

    getCurrentUploads() {
        return this.inprogress;
    }

    cancelUpload(promise) {
        const inprogressKeys = Object.keys(this.inprogress);
        let upload;
        for (let i = 0; i < this.inprogress.length; ++i) {
            const k = inprogressKeys[i];
            if (this.inprogress[k].promise === promise) {
                upload = this.inprogress[k];
                break;
            }
        }
        if (upload) {
            upload.canceled = true;
            MatrixClientPeg.get().cancelUpload(upload.promise);
        }
    }
}
