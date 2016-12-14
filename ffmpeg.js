'use strict';
var uuid, Service, Characteristic, StreamController;

var request = require('request');
var ip = require('ip');
var spawn = require('child_process').spawn;

module.exports = {
  FFMPEG: FFMPEG
};

function FFMPEG(hap, ffmpegOpt) {
  console.log("FFMPEG: ", JSON.stringify(ffmpegOpt));

  uuid = hap.uuid;
  Service = hap.Service;
  Characteristic = hap.Characteristic;
  StreamController = hap.StreamController;

  if (!ffmpegOpt.source) {
    throw new Error("Missing source for camera.");
  }

  this.ffmpegSource = ffmpegOpt.source;

  this.services = [];
  this.streamControllers = [];

  this.pendingSessions = {};
  this.ongoingSessions = {};

  this.videoResolutions = ffmpegOpt.videoResolutions;
  this.snapshotURL = ffmpegOpt.snapshotURL;

  var numberOfStreams = ffmpegOpt.maxStreams || 2;

  let options = {
    proxy: false, // Requires RTP/RTCP MUX Proxy
    srtp: true, // Supports SRTP AES_CM_128_HMAC_SHA1_80 encryption
    video: {
      resolutions: this.videoResolutions,
      codec: {
        profiles: [0, 1, 2], // Enum, please refer StreamController.VideoCodecParamProfileIDTypes
        levels: [0, 1, 2] // Enum, please refer StreamController.VideoCodecParamLevelTypes
      }
    },
    audio: {
      codecs: [
      {
          type: "OPUS", // Audio Codec
          samplerate: 24 // 8, 16, 24 KHz
        },
        {
          type: "AAC-eld",
          samplerate: 16
        }
        ]
      }
    }

    this.createCameraControlService();
    this._createStreamControllers(numberOfStreams, options); 
  }

  FFMPEG.prototype.handleCloseConnection = function(connectionID) {
    this.streamControllers.forEach(function(controller) {
      controller.handleCloseConnection(connectionID);
    });
  }

  FFMPEG.prototype.handleSnapshotRequest = function(req, callback) {
    console.log("Snapsot Request: ", JSON.stringify(req));

    request({
      url: this.snapshotURL, 
      encoding: null
    }, function (error, response, body) {
      if (!error && response.statusCode == 200) {
        callback(undefined, body);
        
        console.log("Snapshot, Size = ", body.length);
      }
    });
  }

  FFMPEG.prototype.prepareStream = function(request, callback) {
    console.log("Prepare Stream Request: ", JSON.stringify(request));

    var sessionInfo = {};

    let sessionID = request["sessionID"];
    let targetAddress = request["targetAddress"];

    sessionInfo["address"] = targetAddress;

    var response = {};

    let videoInfo = request["video"];
    if (videoInfo) {
      let targetPort = videoInfo["port"];
      let srtp_key = videoInfo["srtp_key"];
      let srtp_salt = videoInfo["srtp_salt"];

      let videoResp = {
        port: targetPort,
        ssrc: 1,
        srtp_key: srtp_key,
        srtp_salt: srtp_salt
      };

      response["video"] = videoResp;

      sessionInfo["video_port"] = targetPort;
      sessionInfo["video_srtp"] = Buffer.concat([srtp_key, srtp_salt]);
      sessionInfo["video_ssrc"] = 1; 
    }

    let audioInfo = request["audio"];
    if (audioInfo) {
      let targetPort = audioInfo["port"];
      let srtp_key = audioInfo["srtp_key"];
      let srtp_salt = audioInfo["srtp_salt"];

      let audioResp = {
        port: targetPort,
        ssrc: 1,
        srtp_key: srtp_key,
        srtp_salt: srtp_salt
      };

      response["audio"] = audioResp;

      sessionInfo["audio_port"] = targetPort;
      sessionInfo["audio_srtp"] = Buffer.concat([srtp_key, srtp_salt]);
      sessionInfo["audio_ssrc"] = 1; 
    }

    let currentAddress = ip.address();
    var addressResp = {
      address: currentAddress
    };

    if (ip.isV4Format(currentAddress)) {
      addressResp["type"] = "v4";
    } else {
      addressResp["type"] = "v6";
    }

    response["address"] = addressResp;
    this.pendingSessions[uuid.unparse(sessionID)] = sessionInfo;

    callback(response);
  }

  FFMPEG.prototype.handleStreamRequest = function(request) {
    console.log("Stream Request: ", JSON.stringify(request));

    var sessionID = request["sessionID"];
    var requestType = request["type"];
    if (sessionID) {
      let sessionIdentifier = uuid.unparse(sessionID);

      if (requestType == "start") {
        var sessionInfo = this.pendingSessions[sessionIdentifier];
        if (sessionInfo) {
          let videoInfo = request["video"];

          var width = 0;
          var height = 0;
          var fps = videoInfo.fps;
          var bitrate = videoInfo["max_bit_rate"];
          var maxResolution = true;

          this.videoResolutions.forEach((res) => {
            if(res[0] > videoInfo.width || res[1] > videoInfo.height) {
              //The resolution is larger than requested
              console.log("Possible Res [Too Large]", res);
              maxResolution = false;
              return;
            }

            if(res[0] > width || res[1] > height) {
              width = res[0];
              height = res[1];
              fps = res[2] < fps ? res[2] : fps;
              console.log("Possible Res [Match]", res);
            }
          });
          
          console.log("Negotiated Resolution", width, height, fps, maxResolution);

          let targetAddress = sessionInfo["address"];
          let targetVideoPort = sessionInfo["video_port"];
          let videoKey = sessionInfo["video_srtp"];

          let ffmpegCommand = this.ffmpegSource + ' -threads 0 -vcodec libx264 -an -pix_fmt yuv420p -r '+ fps +' -f rawvideo -tune zerolatency -vf scale='+ width +':'+ height +' -b:v '+ bitrate +'k -bufsize '+ bitrate +'k -payload_type 99 -ssrc 1 -f rtp -srtp_out_suite AES_CM_128_HMAC_SHA1_80 -srtp_out_params '+videoKey.toString('base64')+' srtp://'+targetAddress+':'+targetVideoPort+'?rtcpport='+targetVideoPort+'&localrtcpport='+targetVideoPort+'&pkt_size=1378';
          
          console.log(ffmpegCommand);
          let ffmpeg = spawn('ffmpeg', ffmpegCommand.split(' '), {env: process.env});
          this.ongoingSessions[sessionIdentifier] = ffmpeg;
        }

        delete this.pendingSessions[sessionIdentifier];
      } else if (requestType == "stop") {
        var ffmpegProcess = this.ongoingSessions[sessionIdentifier];
        if (ffmpegProcess) {
          ffmpegProcess.kill('SIGKILL');
        }

        delete this.ongoingSessions[sessionIdentifier];
      }
    }
  }

  FFMPEG.prototype.createCameraControlService = function() {
    var controlService = new Service.CameraControl();

    this.services.push(controlService);
  }

// Private

FFMPEG.prototype._createStreamControllers = function(maxStreams, options) {
  let self = this;

  for (var i = 0; i < maxStreams; i++) {
    var streamController = new StreamController(i, options, self);

    self.services.push(streamController.service);
    self.streamControllers.push(streamController);
  }
}