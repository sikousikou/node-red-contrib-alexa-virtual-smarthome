/**
 * NodeRED Alexa SmartHome
 * Copyright (C) 2021 Claudio Chimera.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 **/

// https://developer.amazon.com/en-US/docs/alexa/account-linking/account-linking-concepts.html
// https://developer.amazon.com/en-US/docs/alexa/device-apis/alexa-errorresponse.html
// https://developer.amazon.com/en-US/docs/alexa/smarthome/state-reporting-for-a-smart-home-skill.html
// https://developer.amazon.com/en-US/docs/alexa/account-linking/account-linking-for-sh-and-other.html
// https://developer.amazon.com/en-US/docs/alexa/smarthome/authenticate-a-customer-permissions.html
// https://developer.amazon.com/docs/login-with-amazon/web-docs.html
// https://developer.amazon.com/en-US/docs/alexa/alexa-skills-kit-sdk-for-nodejs/develop-your-first-skill.html#creating-the-lambda-handler
// https://developer.amazon.com/en-US/docs/alexa/alexa-skills-kit-sdk-for-nodejs/host-web-service.html
// https://developer.amazon.com/en-US/docs/alexa/custom-skills/host-a-custom-skill-as-a-web-service.html#manually-verify-request-sent-by-alexa

/*
https://developer.amazon.com/en-US/docs/alexa/account-linking/account-linking-concepts.html

Resource owner
This is the Alexa user who wants to enable your skill and link it to their account in your system.

Resource server
This is the server that hosts the protected resource (user data) that the Alexa skill needs to access, with the user's permission.

Client
This is the Alexa skill that is making requests to your resource server on behalf of the Alexa user, with the user's permission.

Authorization server
This is the server that identifies and authenticates the identity of the Alexa user with a user in your system.
It plays a key role in account linking in that it: 
1) displays a log-in page for the user to log into your system, 
2) authenticates the user in your system, 
3) generates an authorization code that identifies the user, and 
4) passes the authorization code to the Alexa app, and finally, 
5) accepts the authorization code from the Alexa service and returns an access token that the Alexa service can use to access the user's data in your system. 
Due to that last step, the authorization server is sometimes also called a token server.

*/

module.exports = function (RED) {
    "use strict";

    const path = require('path');
    const fs = require('fs');
    const util = require('util');
    const TokenGenerator = require('uuid-token-generator');
    const express = require('express');
    const helmet = require('helmet');
    const morgan = require('morgan');
    const cors = require('cors');
    const superagent = require('superagent');
    const Throttle = require('superagent-throttle');
    const throttle = new Throttle({
        active: true,     // set false to pause queue
        rate: 10,         // how many requests can be sent every `ratePer`
        ratePer: 5000,    // number of ms in which `rate` requests may be sent
        concurrent: 2     // how many requests can be sent concurrently
    });
    const stoppable = require('stoppable');
    const http = require('http');
    const { SkillRequestSignatureVerifier, TimestampVerifier } = require('ask-sdk-express-adapter');
    //
    const OAUTH_PATH = 'oauth';
    const TOKEN_PATH = 'token';
    const SMART_HOME_PATH = "smarthome";
    const TOKENS_FILENAME = "alexa-tokens_%s.json";
    const GRACE_MILLISECONDS = 500;
    const LWA_TOKEN_URI = 'https://api.amazon.com/auth/o2/token';
    const LWA_USER_PROFILE = 'https://api.amazon.com/user/profile';
    const LWA_AP_OA = 'https://www.amazon.com/ap/oa';

    // ChangeReport Cause Type
    const APP_INTERACTION = 'APP_INTERACTION';
    const PERIODIC_POLL = 'PERIODIC_POLL';
    const PHYSICAL_INTERACTION = 'PHYSICAL_INTERACTION';
    const RULE_TRIGGER = 'RULE_TRIGGER';
    const VOICE_INTERACTION = 'VOICE_INTERACTION';

    const PROPERTIES_MAPPING = {
        motionDetectionState: ['Alexa.MotionSensor', 'detectionState'],
        contactDetectionState: ['Alexa.ContactSensor', 'detectionState']
    };

    const DEFAULT_PAYLOAD_VERSION = '3';
    const PAYLOADS_VERSION = {
        "Alexa.DeviceUsage.Meter": "1.0"
    };

    /******************************************************************************************************************
     *
     *
     */
    class AlexaAdapterNode {
        constructor(config) {
            RED.nodes.createNode(this, config);
            var node = this;
            node.config = config;
            if (node.config.verbose) node._debug("config " + JSON.stringify(config));
            if (node.config.verbose) node._debug("credentials " + JSON.stringify(node.credentials));
            try {
                node.init(config);
            } catch (err) {
                node.error("Init error " + err.stack);
                throw err;
            }
        }

        //
        //
        //
        //
        init(config) {
            var node = this;
            node.http_path = config.http_path || '';
            node.http_port = config.port || '';
            node.http_root = node.Path_join('/', node.http_path.trim());
            node.http_server = RED.httpNode || RED.httpAdmin;
            node.app = node.http_server;
            node.user_dir = RED.settings.userDir || '.';
            node.handler = null;
            node.tokgen = new TokenGenerator(256, TokenGenerator.BASE58);
            node.auth_code = undefined;
            node.devices = {};
            node.tokens_filename = util.format(TOKENS_FILENAME, node.id);

            if (node.config.verbose) node._debug("New " + node.config.name);

            node.on('close', node.shutdown);

            node.setup();
            if (node.config.verbose) node._debug("init completed");
        }

        // Register a new device, called bu the alexa-device
        //
        //
        //
        register(device) {
            var node = this;
            if (node.config.verbose) node._debug("register device id " + device.id + " " + device.type);
            node.devices[device.id] = device;
            process.nextTick(() => {
                node.send_add_or_update_report(device.id);
            });
        }

        // Unregister a device, called bu the alexa-device
        //
        //
        //
        deregister(device, removed) {
            var node = this;
            if (node.config.verbose) node._debug("deregister device id " + device.id + " removed " + removed);
            if (node.device[device.id]) {
                delete node.device[device.id];
            }
            /*if (removed) {
                process.nextTick(() => {
                    node.send_delete_report(device.id, header.correlationToken);
                });
            }*/
            /*if (node.app != node.http_server) {
                if (node.config.verbose) node._debug("Stopping server");
                node.http_server.stop();
                node.http_server = RED.httpNode || RED.httpAdmin;
            }*/
        };

        //
        //
        //
        //
        _debug(msg) {
            console.log('AlexaAdapterNode:' + msg); // TODO REMOVE
            this.debug('AlexaAdapterNode:' + msg);
        }

        //
        //
        //
        //
        setup() {
            var node = this;
            if (node.config.verbose) node._debug("setup server path " + node.http_server.path());
            node.get_tokens()
                .then(() => {
                    if (node.config.verbose) node._debug("setup Tokens loaded");
                })
                .catch(err => {
                    node.error("setup Tokens load error " + err);
                })

            node.UnregisterUrl();
            if (node.http_port.trim()) {
                if (node.config.verbose) node._debug("setup listen port " + node.http_port);
                node.app = express();
                node.app.disable('x-powered-by');
                node.app.use(helmet());
                node.app.use(cors());
                node.app.use(morgan('dev'));
                node.app.set('trust proxy', 1); // trust first proxy
                node.handler = node.app.listen(parseInt(node.http_port), () => {
                    if (node.config.verbose) node._debug(`setup server listening at http://localhost:${node.http_port}${node.http_root}/` + OAUTH_PATH + "|" + TOKEN_PATH + "|" + SMART_HOME_PATH);
                });
                node.http_server = stoppable(http.createServer(node.app), GRACE_MILLISECONDS);
            } else {
                if (node.config.verbose) node._debug("Use the Node-RED port");
            }
            let urlencodedParser = express.urlencoded({ extended: false })
            let jsonParser = express.json()

            node.app.get(node.Path_join(node.http_root, OAUTH_PATH), urlencodedParser, function (req, res) { node.oauth_get(req, res); });
            node.app.post(node.Path_join(node.http_root, OAUTH_PATH), urlencodedParser, function (req, res) { node.oauth_post(req, res); });
            node.app.post(node.Path_join(node.http_root, TOKEN_PATH), urlencodedParser, function (req, res) { node.token_post(req, res); });
            if (node.config.verbose) {
                node.app.get(node.Path_join(node.http_root, TOKEN_PATH), urlencodedParser, function (req, res) { node.token_get(req, res); });
                node.app.get(node.Path_join(node.http_root, SMART_HOME_PATH), urlencodedParser, function (req, res) { node.smarthome_get(req, res); });
            }
            if (node.config.msg_check) {
                node.app.post(node.Path_join(node.http_root, SMART_HOME_PATH), jsonParser, function (req, res) { node.smarthome_post_verify(req, res); });
            } else {
                node.app.post(node.Path_join(node.http_root, SMART_HOME_PATH), jsonParser, function (req, res) { node.smarthome_post(req, res); });
            }
            if (node.config.verbose) node._debug("setup listen path " + node.http_root);
        }

        //
        //
        //
        //
        GetRouteType(route) {
            if (route) {
                if (route.route.methods['get'] && route.route.methods['post']) return "all";
                if (route.route.methods['get']) return "get";
                if (route.route.methods['post']) return "post";
                if (route.route.methods['options']) return "options";
            }
            return 'unknown';
        }

        //
        //
        //
        //
        UnregisterUrl() {
            var node = this;
            if (node._httpNodeRoot !== false && node.app._router) {
                if (node.config.verbose) node._debug("Removing url");
                var get_urls = [node.Path_join(node.http_root, OAUTH_PATH), node.Path_join(node.http_root, TOKEN_PATH), node.Path_join(node.http_root, SMART_HOME_PATH)];
                var post_urls = [node.Path_join(node.http_root, OAUTH_PATH), node.Path_join(node.http_root, TOKEN_PATH), node.Path_join(node.http_root, SMART_HOME_PATH)];
                var options_urls = [];
                var all_urls = [];

                if (node.config.verbose) {
                    node._debug("get_urls " + JSON.stringify(get_urls));
                    node._debug("post_urls " + JSON.stringify(post_urls));
                }

                let to_remove = [];
                node.app._router.stack.forEach(function (route, i) {
                    if (route.route && (
                        (route.route.methods['get'] && get_urls.includes(route.route.path)) ||
                        (route.route.methods['post'] && post_urls.includes(route.route.path)) ||
                        (route.route.methods['options'] && options_urls.includes(route.route.path)) ||
                        (all_urls.includes(route.route.path))
                    )) {
                        node.debug('UnregisterUrl: removing url: ' + route.route.path + " registred for " + node.GetRouteType(route));
                        to_remove.unshift(i);
                    }
                });
                to_remove.forEach(i => node.app._router.stack.splice(i, 1));
                node.app._router.stack.forEach(function (route) {
                    if (route.route) node.debug('UnregisterUrl: remaining url: ' + route.route.path + " registred for " + node.GetRouteType(route));
                });
            }
        }

        //
        //
        //
        //
        shutdown(removed, done) {
            var node = this;
            if (node.config.verbose) node._debug("(on-close)");
            node.UnregisterUrl();
            if (node.handler) {
                if (node.config.verbose) node._debug("Stopping server");
                node.http_server.stop(function (err, grace) {
                    if (node.config.verbose) node._debug("Server stopped " + grace + " " + err);
                });
                node.handler.close(() => {
                    if (node.config.verbose) node._debug("Server stopped");
                });
                node.handler = null;
            }
            if (removed) {
                // this node has been deleted
                if (node.config.verbose) node._debug("shutdown: removed");
            } else {
                // this node is being restarted
                if (node.config.verbose) node._debug("shutdown: stopped");
            }
            if (typeof done === 'function') {
                done();
            }
        }

        //
        //
        //
        //
        oauth_get(req, res) {
            var node = this;
            if (node.config.verbose) node._debug('oauth_get');
            if (node.config.verbose) node._debug('oauth_get CCHI ' + JSON.stringify(req.query));

            if (typeof req.query.policy !== 'undefined') {
                return node.show_policy_page(res);
            }
            if (typeof req.query.error !== 'undefined' && typeof req.query.client_id === 'undefined') {
                return res.status(500).send(req.query.error);
            }
            // Manage Login with Amazon
            if (node.config.login_with_amazon) {
                // Second request
                if (node.skill_link_req && req.query.access_token && req.query.token_type === 'bearer' && req.query.scope &&
                    req.query.expires_in && Number.isInteger(parseInt(req.query.expires_in))) {
                    if (node.config.verbose) node.error('oauth_get access_token');
                    // Get User Profile
                    node.get_user_profile(req.query.access_token)
                        .then(pres => {
                            if (node.config.verbose) node._debug("get_user_profile CCHI pres " + JSON.stringify(pres));
                            if (node.config.emails.includes(pres.email)) {
                                const oauth_redirect_uri = 'https://' + node.Path_join(req.get('Host'), node.http_root, OAUTH_PATH);
                                if (node.config.verbose) node._debug('oauth_get CCHI oauth_redirect_uri ' + JSON.stringify(oauth_redirect_uri));
                                const state = node.tokgen.generate();
                                node.login_with_amazon = { // TODO REMOVE
                                    state: state
                                };
                                return res.redirect(util.format('%s?client_id=%s&scope=profile&response_type=code&redirect_uri=%s&state=%s', LWA_AP_OA, node.credentials.oa2_client_id, oauth_redirect_uri, state));
                            }
                        })
                        .catch(err => {
                            node.error("get_user_profile err " + err);
                            node.show_login_page(res, true);
                        });
                    return;
                }
                if (node.skill_link_req && req.query.code && req.query.scope === 'profile') {
                    if (node.config.verbose) node.error('oauth_get profile');
                    return node.manage_login_with_amazon_access_token(req, res);
                }
            }
            if (node.config.verbose) node.error('oauth_get login');
            node.skill_link_req = {};
            const client_id = req.query.client_id || '';
            const response_type = req.query.response_type || '';
            const state = req.query.state || '';
            const scope = req.query.scope || '';
            const redirect_uri = req.query.redirect_uri || '';
            const error = req.query.error || '';
            if (client_id !== node.credentials.your_client_id) {
                node.error("oauth_get: Wrong client id " + client_id);
                return res.status(500).send('Wrong client id');
            }
            if (response_type !== "code") {
                node.error("oauth_get: Wrong response type " + response_type);
                return res.status(500).send('Wrong response type');
            }
            if (state.trim().length === 0) {
                node.error("oauth_get: Missing state " + state);
                return res.status(500).send('Wrong state');
            }
            if (scope !== node.config.scope) {
                node.error("oauth_get: Wrong scope " + scope);
                return res.status(500).send('Wrong scope');
            }
            if (redirect_uri === undefined || redirect_uri.trim().length === 0) {
                node.error("oauth_get: Wrong redirect uri " + redirect_uri);
                return res.status(500).send('Wrong redirect uri');
            }
            node.skill_link_req.client_id = req.query.client_id;
            node.skill_link_req.response_type = req.query.response_type;
            node.skill_link_req.state = req.query.state;
            node.skill_link_req.scope = req.query.scope;
            node.skill_link_req.redirect_uri = req.query.redirect_uri;
            node.skill_link_req.token_uri = 'https://' + req.get('Host') + node.Path_join(node.http_root, TOKEN_PATH);
            node.skill_link_req.oauth_uri = 'https://' + req.get('Host') + node.Path_join(node.http_root, OAUTH_PATH);
            node.show_login_page(res);
        }

        //
        //
        //
        //
        oauth_post(req, res) {
            var node = this;
            if (node.config.verbose) node._debug('oauth_post');
            if (node.config.verbose) node._debug('oauth_post CCHI ' + JSON.stringify(req.body));
            const username = req.body.username || '';
            const password = req.body.password || '';
            const client_id = req.body.client_id || '';
            const response_type = req.body.response_type || '';
            const state = req.body.state || '';
            const scope = req.body.scope || '';
            const redirect_uri = req.body.redirect_uri || '';
            if (node.config.verbose) node.error('oauth_post username ' + username);
            if (node.config.login_with_amazon && (username || password)) {
                node.error("oauth_post: Login with username is not enabled");
                return res.status(500).send('Wrong request');
            }
            if (client_id === undefined || client_id.trim().length === 0) {
                node.error("oauth_post: Wrong client id " + client_id);
                return res.status(500).send('Wrong client id');
            }
            if (response_type !== "code") {
                node.error("oauth_post: Wrong response type " + response_type);
                return res.status(500).send('Wrong response type');
            }
            if (state === undefined || state.trim().length === 0) {
                node.error("oauth_post: Wrong state " + state);
                return res.status(500).send('Wrong state');
            }
            if (scope === undefined || state.trim().scope === 0) {
                node.error("oauth_post: Wrong scope " + scope);
                return res.status(500).send('Wrong scope');
            }
            if (redirect_uri === undefined || redirect_uri.trim().length === 0) {
                node.error("oauth_post: Wrong redirect uri " + redirect_uri);
                return res.status(500).send('Wrong redirect uri');
            }
            if (username !== node.credentials.username || password !== node.credentials.password.replace(/\\/g, "")) {
                // Redirect to login with error
                if (username !== node.credentials.username) {
                    node.error('oauth_post: oauth_post: invalid username ' + username);
                    node.error('oauth_post: invalid username CCHI ' + node.credentials.username);
                }
                if (password !== node.credentials.password) {
                    node.error('oauth_post: oauth_post: invalid password ' + password);
                    node.error('oauth_post: invalid password CCHI ' + node.credentials.password.replace(/\\/g, ""));
                }
                return node.redirect_to_login_page(res, true);
                /*return res.redirect(util.format(
                    '%s?client_id=%s&redirect_uri=%s&state=%s&response_type=code&scope=%s&error=invalid_user',
                    node.Path_join(node.http_root, OAUTH_PATH), client_id, encodeURIComponent(redirect_uri), state, scope));*/
            }
            node.auth_code = {
                code: node.tokgen.generate(),
                expire_at: Date.now() + 3600 * 1000,
                redirect_uri: redirect_uri,
            }
            let sep;
            if (redirect_uri.includes('?')) {
                sep = '&';
            }
            else {
                sep = '?';
            }
            if (node.config.verbose) node._debug("oauth_post: redirect to " + util.format('%s%sstate=%s&code=%s', redirect_uri, sep, encodeURIComponent(state), 'XXXXX'));
            return res.redirect(util.format('%s%sstate=%s&code=%s', redirect_uri, sep, encodeURIComponent(state), encodeURIComponent(node.auth_code.code)));
        }

        //
        //
        //
        //
        token_get(req, res) {
            var node = this;
            if (node.config.verbose) node._debug('token_get');
            const uri = 'https://' + node.Path_join(req.get('Host'), node.http_root, TOKEN_PATH);
            res.status(200).send(uri);
        }

        //
        //
        //
        //
        token_post(req, res) {
            var node = this;
            if (node.config.verbose) node._debug('token_post');
            if (node.config.verbose) node._debug('token_post CCHI ' + JSON.stringify(req.body));
            const grant_type = req.body.grant_type || '';
            const client_id = req.body.client_id || '';
            const client_secret = req.body.client_secret || '';
            if (grant_type === 'refresh_token') {
                if (node.config.verbose) node.error('token_post refresh_token');
                const refresh_token = req.body.refresh_token || '';
                if (refresh_token === node.tokens.own.refresh_token &&
                    client_id === node.credentials.your_client_id &&
                    client_secret === node.credentials.your_secret) {
                    node.tokens.own.access_token = "Atza|" + node.tokgen.generate();
                    node.tokens.own.expire_at = Date.now() + 3600 * 1000
                    node.save_tokens()
                        .then(() => {
                            if (node.config.verbose) node._debug("token_post save_tokens ok");
                        })
                        .catch(err => {
                            node.error("token_post save_tokens error " + err);
                        });
                    const tokens = {
                        "access_token": node.tokens.own.access_token,
                        "token_type": "bearer",
                        "expires_in": 3600,
                        "refresh_token": node.tokens.own.refresh_token
                    };
                    if (node.config.verbose) node._debug("Returns new access_token");
                    res.json(tokens);
                    res.end();
                    return;
                }
                if (refresh_token !== node.tokens.own.refresh_token) node.error("Unauthorized refresh_token");
                if (client_id !== node.credentials.your_client_id) node.error("Unauthorized client_id");
            }
            else if (grant_type === 'authorization_code') {
                if (node.config.verbose) node.error('token_post authorization_code');
                if (!node.auth_code) {
                    node.error("Wrong code");
                    return res.status(500).send('Wrong code');
                }
                const code = req.body.code || '';
                const expire_at = node.auth_code.expire_at || 0;
                if (code === node.auth_code.code &&
                    client_id === node.credentials.your_client_id &&
                    client_secret === node.credentials.your_secret &&
                    Date.now() < expire_at) {
                    node.auth_code = {};
                    node.tokens['own'] = {
                        access_token: "Atza|" + node.tokgen.generate(),
                        expire_at: Date.now() + 3600 * 1000,
                        refresh_token: "Atzr|" + node.tokgen.generate()
                    };
                    node.save_tokens()
                        .then(() => {
                            if (node.config.verbose) node._debug("token_post save_tokens ok");
                            const tokens = {
                                "access_token": node.tokens.own.access_token,
                                "token_type": "bearer",
                                "expires_in": 3600,
                                "refresh_token": node.tokens.own.refresh_token
                            };
                            if (node.config.verbose) node._debug("Returns tokens");
                            if (node.config.verbose) node._debug("Returns tokens " + JSON.stringify(tokens));
                            res.json(tokens);
                            res.end();
                        })
                        .catch(err => {
                            node.error("token_post save_tokens error " + err);
                            res.status(400).send('Persistence error');
                        });
                    return;
                }
                if (code !== node.auth_code.code) node.error("Unauthorized code");
            }
            node.auth_code = {};
            if (client_secret !== node.credentials.your_secret) node.error("Unauthorized client_secret");
            return res.status(401).send('Unauthorized');
        }

        //
        //
        //
        //
        smarthome_get(req, res) {
            var node = this;
            if (node.config.verbose) node._debug('smarthome_get');
            const uri = 'https://' + node.Path_join(req.get('Host'), node.http_root);
            // res.status(200).send(node.Path_join(uri, SMART_HOME_PATH));
            node.show_test_page(res, uri);
        }

        //
        //
        //
        //
        smarthome_post_verify(req, res) {
            var node = this;
            if (node.config.verbose) node._debug("smarthome_post_verify");
            if (!node.config.verbose) {
                new SkillRequestSignatureVerifier()
                    .verify(req.body, req.header)
                    .then(() => {
                        new TimestampVerifier()
                            .verify(req.body)
                            .then(() => {
                                node.smarthome_post(req, res);
                            })
                            .catch(err => {
                                node.error("smarthome_post_verify: TimestampVerifier error " + err.stack);
                                return res.status(401).send('Bad request');
                            });
                    })
                    .catch(err => {
                        node.error("smarthome_post_verify: SkillRequestSignatureVerifier error " + err.stack);
                        return res.status(401).send('Bad request');
                    });
            }
        }

        //
        //
        //
        //
        smarthome_post(req, res) {
            var node = this;
            if (node.config.verbose) node._debug("smarthome_post");
            if (node.config.verbose) node._debug('smarthome_post CCHI ' + JSON.stringify(req.body));
            if (!node.tokens) {
                node.error("Wrong tokens");
                return res.status(401).send('Wrong tokens');
            }
            let scope = {};
            let endpointId = undefined;
            if (node.config.verbose && req.body.directive.header.namespace === 'Test') {
                res.json({ ok: 'ok' });
                return res.end();
            }
            if (req.body.directive.payload && req.body.directive.payload.scope) {
                scope = req.body.directive.payload.scope;
            } else if (req.body.directive.endpoint && req.body.directive.endpoint.scope) {
                scope = req.body.directive.endpoint.scope;
                endpointId = req.body.directive.endpoint.endpointId;
            } else if (req.body.directive.payload && req.body.directive.payload.grantee) {
                scope = req.body.directive.payload.grantee;
            }
            if (typeof req.body.directive.header !== 'object') {
                node.error("smarthome_post: Wrong request header");
                return res.status(401).send('Wrong request');
            }
            const header = req.body.directive.header;
            if (typeof header.namespace !== 'string') {
                node.error("smarthome_post: Wrong request namespace");
                return res.status(401).send('Wrong request');
            }
            if (typeof header.name !== 'string') {
                node.error("smarthome_post: Wrong request name");
                return res.status(401).send('Wrong request');
            }
            const payload_version = header.payloadVersion;
            if (payload_version !== (PAYLOADS_VERSION[header.namespace] || DEFAULT_PAYLOAD_VERSION)) {
                node.error("smarthome_post: Wrong request payload_version " + payload_version + " for " + header.namespace);
                return res.status(401).send('Unsupported payload version');
            }
            if (node.tokens.own.access_token !== scope.token || "BearerToken" !== scope.type) {
                node.error("smarthome_post: Wrong authorization");
                return res.status(401).send('Wrong authorization');
            }
            if (node.tokens.own.expire_at < Date.now()) {
                node.error("smarthome_post: Expired credential");
                return res.status(401).send('EXPIRED_AUTHORIZATION_CREDENTIAL');
            }

            const namespace = header.namespace;
            const name = header.name;

            if (node.config.verbose) node._debug("CCHI received directive " + JSON.stringify(namespace) + " " + JSON.stringify(name) + " " + JSON.stringify(endpointId));
            if (namespace === "Alexa.Authorization" && name === 'AcceptGrant') {
                if (node.config.verbose) node.error('smarthome_post: oauth_get AcceptGrant');
                // https://developer.amazon.com/en-US/docs/alexa/smarthome/authenticate-a-customer-permissions.html
                return node.accept_grant(req, res);
            }
            const messageId = node.tokgen.generate();
            let error = false;
            let error_message = '';
            if (endpointId) {
                if (node.devices[endpointId]) {
                    if (node.config.verbose) node._debug("endpoint id " + endpointId + " name " + node.devices[endpointId].config.name);
                    if (namespace === "Alexa" && name === 'ReportState') {
                        node.get_access_token('evn')
                            .then(access_token => {
                                const report_state = node.get_report_state(endpointId, header.correlationToken, access_token, messageId);
                                if (node.config.verbose) node._debug("CCHI report_state response " + JSON.stringify(report_state));
                                res.json(report_state);
                                res.end();
                            })
                            .catch(err => {
                                node.error("smarthome_post ReportState get_access_token evn error " + err);
                                node.send_error_response(res, messageId, endpointId);
                            });
                        return;
                    } else {
                        if (node.config.verbose) node._debug(" CCHI directive " + namespace + " " + name + " " + JSON.stringify(req.body.directive.payload));
                        try {
                            let cmd_res = {};
                            const changed_property_names = node.devices[endpointId].execDirective(header, req.body.directive.payload, cmd_res);
                            if (changed_property_names !== undefined) {
                                node.get_access_token('evn')
                                    .then(access_token => {
                                        const r_namespace = cmd_res['namespace'];
                                        const r_name = cmd_res['name'];
                                        delete cmd_res['name'];
                                        delete cmd_res['namespace'];
                                        let response = node.get_response_report(endpointId, header.correlationToken, access_token, r_namespace, r_name);
                                        node.objectMerge(response, cmd_res);
                                        if (node.config.verbose) node._debug("CCHI " + namespace + " " + name + " response " + JSON.stringify(response));
                                        res.json(response);
                                        res.end();
                                        // const report_state = node.get_report_state(endpointId, header.correlationToken, access_token, messageId);
                                        // if (node.config.verbose) node._debug("CCHI report_state async response NOT SENT YET " + JSON.stringify(report_state));
                                        if (r_name != 'DeferredResponse' && r_name != 'ErrorResponse' && r_namespace != "Alexa.SceneController") {
                                            process.nextTick(() => {
                                                node.send_change_report(endpointId, changed_property_names, VOICE_INTERACTION, cmd_res).then(() => { });
                                            });
                                        }
                                    })
                                    .catch(err => {
                                        node.error("smarthome_post get_access_token evn error " + err);
                                        node.send_error_response(res, messageId, endpointId, error, error_message);
                                    });
                                return;
                            } else {
                                error = 'INVALID_DIRECTIVE';
                                error_message = RED._("alexa-adapter.error.invalid-directive")
                                node.error("smarthome_post: execDirective unknown directive " + namespace + " " + name);
                                node.send_error_response(res, messageId, endpointId, error, error_message);
                            }
                        } catch (err) {
                            node.error("smarthome_post: execDirective error " + err.stack);
                            error = 'INVALID_DIRECTIVE';
                            error_message = RED._("alexa-adapter.error.invalid-directive")
                            node.error("CCHI execDirective error");
                            node.send_error_response(res, messageId, endpointId, error, error_message);
                        }
                    }
                } else {
                    error = 'NO_SUCH_ENDPOINT';
                    error_message = RED._("alexa-adapter.error.invalid-directive")
                    node.error("smarthome_post: no such endpoint");
                    node.send_error_response(res, messageId, endpointId, error, error_message);
                    process.nextTick(() => {
                        node.send_delete_report(endpointId, header.correlationToken);
                    });
                }
            } else {
                if (namespace === "Alexa.Discovery" && name === 'Discover') {
                    let endpoints = [];
                    const discovery = {
                        event: {
                            header: {
                                namespace: "Alexa.Discovery",
                                name: "Discover.Response",
                                payloadVersion: PAYLOADS_VERSION[namespace] || DEFAULT_PAYLOAD_VERSION,
                                messageId: messageId,
                            },
                            payload: {
                                endpoints: endpoints
                            }
                        }
                    };
                    Object.keys(node.devices).forEach(function (key) {
                        const device = node.devices[key];
                        endpoints.push(device.endpoint);
                    });
                    if (node.config.verbose) node._debug("CCHI discovery " + JSON.stringify(discovery));
                    res.json(discovery);
                    res.end();
                } else {
                    node.error("No endpoint for directive " + JSON.stringify(namespace) + " " + JSON.stringify(name));
                    error = 'INVALID_DIRECTIVE';
                    error_message = RED._("alexa-adapter.error.invalid-directive")
                    node.send_error_response(res, messageId, endpointId, error, error_message);
                }
            }
        }

        //
        //
        //
        //
        // https://developer.amazon.com/en-US/docs/alexa/device-apis/alexa-errorresponse.html
        send_error_response(res, messageId, endpointId, error_type, error_message) {
            var node = this;
            const error_msg = node.get_error_response(error_type, error_message, endpointId, messageId);
            if (node.config.verbose) node._debug("CCHI send_error_response " + JSON.stringify(error_msg));
            if (res) {
                res.json(error_msg);
                res.end();
            } else {
                node.get_access_token('evn')
                    .then(access_token => {
                        if (node.config.verbose) node._debug('send_error_response error_msg ' + JSON.stringify(error_msg));
                        if (node.config.verbose) node._debug('send_change_report to event_endpoint ' + node.config.event_endpoint);
                        superagent
                            .post(node.config.event_endpoint)
                            .use(throttle.plugin())
                            .set('Authorization', 'Bearer ' + access_token)
                            .send(error_msg)
                            .end((err, res) => {
                                if (err) {
                                    node.error('send_change_report err ' + JSON.stringify(err));
                                    reject(err);
                                } else {
                                    if (node.config.verbose) node._debug('send_change_report res ' + JSON.stringify(res));
                                    resolve(res);
                                }
                            });
                        if (node.config.verbose) node._debug('send_change_report sent');
                    })
                    .catch(err => {
                        node.error('send_change_report get_access_token err ' + JSON.stringify(err));
                    });
            }
        }

        //
        //
        //
        //
        get_error_response(error_type, error_message, endpointId, messageId) {
            var node = this;
            let error_msg = {
                event: {
                    header: {
                        namespace: "Alexa",
                        name: "ErrorResponse",
                        messageId: messageId || node.tokgen.generate(),
                        payloadVersion: PAYLOADS_VERSION['Alexa'] || DEFAULT_PAYLOAD_VERSION
                    },
                    payload: {
                        type: error_type || 'INTERNALerror',
                        message: error_message || 'Unknown error'
                    }
                }
            };
            if (endpointId) {
                error_msg.event['endpoint'] = {
                    endpointId: endpointId
                };
            }
            return error_msg;
        }
        //
        //
        //
        //
        show_login_page(res, error) {
            var node = this;
            // Show login page
            fs.readFile(path.join(__dirname, 'html/login.html'), 'utf8', function (err, data) {
                if (err) {
                    res.status(500).send('No data');
                    node.error("Load error " + err);
                } else {
                    const error_message = RED._('alexa-adapter.error.login-error');
                    //.set("Content-Security-Policy", "default-src 'self'; style-src https://stackpath.bootstrapcdn.com; img-src *; 'unsafe-inline' *.alexa.com")
                    // .set("Content-Security-Policy", "default-src 'self'; style-src https://stackpath.bootstrapcdn.com 'unsafe-inline'; img-src *; script-src 'self' http://* 'unsafe-inline' 'unsafe-eval' *.alexa.com")
                    res
                        .set("Content-Security-Policy",
                            "default-src 'self' 'unsafe-inline' *.alexa.com https://*.media-amazon.com ; " +
                            "style-src https://stackpath.bootstrapcdn.com 'unsafe-inline' ; " +
                            "img-src https://upload.wikimedia.org https://nodered.org https://images-na.ssl-images-amazon.com ; " +
                            "script-src 'self' http://* https://assets.loginwithamazon.com 'unsafe-inline' ; " +
                            "frame-src https://*.amazon.com"
                        )
                        .send(data.replace(/CLIENT_ID/g, node.credentials.oa2_client_id)
                            .replace(/VERBOSE/g, node.config.verbose)
                            .replace(/LOGIN_WITH_AMAZON/g, '' + node.config.login_with_amazon)
                            .replace(/ERROR_MESSAGE/g, error_message));
                }
            });
        }

        //
        //
        //
        //
        show_test_page(res, url) {
            var node = this;
            // Show login page
            fs.readFile(path.join(__dirname, 'html/test.html'), 'utf8', function (err, data) {
                if (err) {
                    res.status(500).send('No page available');
                    node.error("Load error " + err);
                } else {
                    res
                        .set("Content-Security-Policy",
                            "default-src 'self' 'unsafe-inline' ; " +
                            "img-src https://nodered.org ; " +
                            "script-src 'self' https://code.jquery.com 'unsafe-inline' ; "
                        )
                        .send(data.replace(/alexa_smarthome_url/g, url));
                }
            });
        }

        //
        //
        //
        //
        show_policy_page(res) {
            var node = this;
            // Show login page
            fs.readFile(path.join(__dirname, 'html/policy.html'), 'utf8', function (err, data) {
                if (err) {
                    res.status(500).send('No policy available');
                    node.error("Load error " + err);
                } else {
                    const privacy_policy = RED._('alexa-adapter.label.privacy_policy');
                    const privacy_policy_content = RED._('alexa-adapter.label.privacy_policy_content');
                    res
                        .send(data.replace(/privacy_policy_content/g, privacy_policy_content)
                            .replace(/privacy_policy/g, privacy_policy));
                }
            });
        }

        //
        //
        //
        //
        get_user_profile(access_token, type) {
            var node = this;
            return new Promise((resolve, reject) => {
                (access_token ? Promise.resolve({ access_token: access_token }) : node.get_access_token(type || 'lwa'))
                    .then(res => {
                        if (node.config.verbose) node._debug("get_user_profile CCHI access_token res " + JSON.stringify(res));
                        superagent
                            .get(LWA_USER_PROFILE)
                            .set("Authorization", "Bearer " + res.access_token)
                            .set("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8")
                            .accept('application/json')
                            .then(res => {
                                if (node.config.verbose) node._debug("get_user_profile CCHI profile res " + JSON.stringify(res));
                                if (res.status === 200) {
                                    resolve(JSON.parse(res.text));
                                } else {
                                    reject(res.text.error_description);
                                }
                            })
                            .catch(err => {
                                node.error("get_user_profile profile error " + err.stack);
                                reject(err);
                            });
                    })
                    .catch(err => {
                        node.error("get_user_profile access_token error " + err.stack);
                        reject(err);
                    });
            });
        }

        //
        //
        //
        //
        accept_grant(req, res) {
            var node = this;
            if (node.config.verbose) node._debug('accept_grant');
            // https://developer.amazon.com/en-US/docs/alexa/device-apis/alexa-authorization.html
            // https://developer.amazon.com/docs/login-with-amazon/web-docs.html
            // https://developer.amazon.com/docs/login-with-amazon/authorization-code-grant.html
            // https://developer.amazon.com/en-US/docs/alexa/smarthome/authenticate-a-customer-permissions.html
            const payload = req.body.directive.payload;
            if (payload &&
                payload.grant && payload.grant.type === 'OAuth2.AuthorizationCode' && payload.grant.code) {
                const code = payload.grant.code;
                const token = payload.grantee.token;
                const oa2_client_id = node.config.oa2_client_id;
                const oa2_secret = node.config.oa2_secret;

                node.get_access_token('evn', payload.grant.code)
                    .then(() => {
                        if (node.config.verbose) node._debug("accept_grant tokens evn OK");
                        const ok_response = {
                            event: {
                                header: {
                                    namespace: "Alexa.Authorization",
                                    name: "AcceptGrant.Response",
                                    messageId: node.tokgen.generate(),
                                    payloadVersion: PAYLOADS_VERSION['Alexa.Authorization'] || DEFAULT_PAYLOAD_VERSION
                                },
                                payload: {}
                            }
                        };
                        res.json(ok_response);
                        res.end();
                    })
                    .catch(err => {
                        node.error("accept_grant tokens evn error " + err);
                        node.send_accept_granterror(res, "Failed to handle the AcceptGrant directive because cannot store the token.");
                    });
            } else {
                node.error("accept_grant wrong grant");
                node.send_accept_granterror(res);
            }
        }

        //
        //
        //
        //
        send_accept_granterror(res, msg) {
            var node = this;
            if (node.config.verbose) node._debug('send_accept_granterror');
            const error_response = {
                event: {
                    header: {
                        messageId: node.tokgen.generate(),
                        namespace: "Alexa.Authorization",
                        name: "ErrorResponse",
                        payloadVersion: PAYLOADS_VERSION["Alexa.Authorization"] || DEFAULT_PAYLOAD_VERSION
                    },
                    payload: {
                        type: "ACCEPT_GRANT_FAILED",
                        message: RED._(msg || "alexa-adapter.error.accept-grant-directive")
                    }
                }
            };
            node.error("send_accept_granterror " + JSON.stringify(error_response));
            res.json(error_response);
            res.end();
        }

        //
        //
        //
        //
        manage_login_with_amazon_access_token(oreq, ores) {
            var node = this;
            if (node.config.verbose) node._debug('manage_login_with_amazon_access_token');
            // https://developer.amazon.com/docs/login-with-amazon/authorization-code-grant.html
            const code = oreq.query.code || '';
            const state = oreq.query.state || '';
            const scope = oreq.query.scope || '';

            if (node.config.verbose) node._debug("manage_login_with_amazon_access_token CCHI config " + JSON.stringify(node.config));
            if (node.config.verbose) node._debug("manage_login_with_amazon_access_token CCHI credentials " + JSON.stringify(node.credentials));
            if (node.skill_link_req && code.trim() && scope === 'profile') {
                node.get_access_token('lwa', code)
                    .then(res => {
                        if (node.config.verbose) node._debug("mlwaat get_access_token CCHI res " + res);
                        node.get_user_profile(res)
                            .then(pres => {
                                if (node.config.verbose) node._debug("get_user_profile CCHI res " + JSON.stringify(pres));
                                if (node.config.emails.includes(pres.email)) {
                                    if (node.config.verbose) {
                                        node._debug(pres.email + ' OK');
                                        node.error("Username " + pres.email + " authorized");
                                    }
                                    node.auth_code = {
                                        code: node.tokgen.generate(),
                                        expire_at: Date.now() + 60 * 2 * 1000
                                    };
                                    if (node.config.verbose) node._debug("manage_login_with_amazon_access_token CCHI auth_code " + JSON.stringify(node.auth_code));
                                    node.redirect_to_amazon(ores, node.auth_code.code);
                                } else {
                                    if (node.config.verbose) node._debug(pres.email + ' NOK');
                                    node.error("Username " + pres.email + " not authorized");
                                    node.redirect_to_login_page(ores, true);
                                }
                            })
                            .catch(err => {
                                node.error("mlwaat get_user_profile error " + err);
                                node.redirect_to_login_page(ores, true);
                                /*
                                error	An ASCII error code with an error code value.
                                error_description	A human-readable ASCII string with information about the error, useful for client developers.
                                error_uri	A URI to a web page with human-readable information about the error, useful for client developers.
                                state	The client state passed in the original authorization request.
                                */
                            });
                    })
                    .catch(err => {
                        node.error("mlwaat get_access_token error " + err);
                        node.redirect_to_login_page(ores, true);
                    });
            } else {
                if (node.config.verbose) node._debug("manage_login_with_amazon_access_token ERROR");
                node.redirect_to_login_page(ores, true);
            }
        }

        //
        //
        //
        //
        redirect_to_login_page(res, err) {
            var node = this;
            if (node.config.verbose) node._debug('redirect_to_login_page');
            return res.redirect(util.format(
                '%s?client_id=%s&redirect_uri=%s&state=%s&response_type=code&scope=%s%s',
                node.Path_join(node.http_root, OAUTH_PATH), encodeURIComponent(node.skill_link_req.client_id), encodeURIComponent(node.skill_link_req.redirect_uri),
                node.skill_link_req.state, node.skill_link_req.scope, err ? '&error=invalid_user' : ''));
        }

        //
        //
        //
        //
        redirect_to_amazon(res, code) {
            var node = this;
            const url = util.format('%s?state=%s&code=%s', node.skill_link_req.redirect_uri, node.skill_link_req.state, code);
            if (node.config.verbose) node._debug('redirect_to_amazon to ' + url);
            return res.redirect(url);
        }

        //
        //
        //
        //
        get_all_states() {
            var node = this;
            let states = {};
            Object.keys(node.devices).forEach(function (key) {
                const device = node.devices[key];
                if (Object.keys(device.state).length > 0) {
                    states[device.id] = device.state;
                }
            });
            return states;
        }

        //
        //
        //
        //
        get_all_names() {
            var node = this;
            let names = {};
            Object.keys(node.devices).forEach(function (key) {
                const device = node.devices[key];
                names[device.id] = device.config.name;
            });
            return names;
        }

        //
        //
        //
        //
        get_devices_id_name(names, topics) {
            var node = this;
            let id_names = {};
            if (names === undefined) {
                names = [];
            }
            if (topics === undefined) {
                topics = [];
            }
            Object.keys(node.devices).forEach(function (key) {
                const device = node.devices[key];
                if (names.includes(device.config.name) || topics.includes(device.config.topic)) {
                    id_names[key] = device.config.name;
                }
            });
            return id_names;
        }

        //
        //
        //
        //
        // https://developer.amazon.com/en-US/docs/alexa/smarthome/send-events-to-the-alexa-event-gateway.html
        // https://developer.amazon.com/en-US/docs/alexa/device-apis/alexa-response.html
        get_report_state(endpointId, correlationToken, access_token, messageId) {
            var node = this;
            const state = {
                event: {
                    header: {
                        namespace: "Alexa",
                        name: "StateReport",
                        messageId: messageId,
                        correlationToken: correlationToken,
                        payloadVersion: PAYLOADS_VERSION["Alexa"] || DEFAULT_PAYLOAD_VERSION,
                    },
                    endpoint: {
                        scope: {
                            type: "BearerToken",
                            token: access_token
                        },
                        endpointId: endpointId,
                        cookie: {}
                    },
                    payload: {},
                },
                context: {
                    properties: node.devices[endpointId].getProperties()
                }
            }
            return state;
        }

        //
        //
        //
        //
        // 
        // https://developer.amazon.com/en-US/docs/alexa/device-apis/alexa-discovery.html
        get_delete_report(endpointIds, correlationToken, access_token) {
            var node = this;
            let endpoints = [];
            if (typeof endpointIds === 'string') {
                endpoints.push({
                    endpointId: endpointIds
                });
            } else {
                endpointIds.forEach(endpointId => {
                    endpoints.push({
                        endpointId: endpointId
                    });
                });
                endpointIds = endpointIds[0];
            }
            const msg = {
                event: {
                    header: {
                        namespace: "Alexa",
                        name: "DeleteReport",
                        correlationToken: correlationToken,
                        messageId: node.tokgen.generate(),
                        payloadVersion: PAYLOADS_VERSION['Alexa'] || DEFAULT_PAYLOAD_VERSION,
                    },
                    endpoint: {
                        scope: {
                            type: "BearerToken",
                            token: access_token
                        },
                        endpointId: endpointIds
                    },
                    payload: {
                        endpoints: endpoints
                    },
                    scope: {
                        "type": "BearerToken",
                        "token": access_token
                    }
                }
            }
            return msg;
        }

        //
        //
        //
        //
        send_doorbell_press(endpointId, cause) {
            // https://developer.amazon.com/en-US/docs/alexa/device-apis/alexa-doorbelleventsource.html
            var node = this;
            if (node.config.verbose) node._debug('send_doorbell_press' + cause);

            node.get_access_token('evn')
                .then(access_token => {
                    const state = {
                        context: {},
                        event: {
                            header: {
                                namespace: "Alexa.DoorbellEventSource",
                                name: "DoorbellPress",
                                messageId: node.tokgen.generate(),
                                payloadVersion: PAYLOADS_VERSION['Alexa.DoorbellEventSource'] || DEFAULT_PAYLOAD_VERSION
                            },
                            endpoint: {
                                scope: {
                                    type: "BearerToken",
                                    token: access_token
                                },
                                endpointId: endpointId
                            },
                            payload: {
                                cause: {
                                    type: cause || "PHYSICAL_INTERACTION"
                                },
                                timestamp: new Date().toISOString()
                            }
                        },
                    };
                    if (node.config.verbose) node._debug('send_doorbell_press ' + JSON.stringify(state));
                    superagent
                        .post(node.config.event_endpoint)
                        .use(throttle.plugin())
                        .set('Authorization', 'Bearer ' + access_token)
                        .send(state)
                        .end((err, res) => {
                            if (err) {
                                node.error('send_doorbell_press err ' + JSON.stringify(err));
                            } else {
                                if (node.config.verbose) node._debug('send_doorbell_press res ' + JSON.stringify(res));
                            }
                        });
                    if (node.config.verbose) node._debug('send_doorbell_press sent');
                })
                .catch(err => {
                    node.error('send_doorbell_press get_access_token err ' + JSON.stringify(err));
                })
        }

        //
        //
        //
        //
        send_event_gw(endpointId, namespace, name, payload, other_data) {
            // https://github.com/alexa/alexa-smarthome/blob/master/sample_async/python/sample_async.py
            // https://developer.amazon.com/en-US/docs/alexa/smarthome/state-reporting-for-a-smart-home-skill.html
            // https://developer.amazon.com/en-US/docs/alexa/smarthome/send-events-to-the-alexa-event-gateway.html
            var node = this;
            return new Promise((resolve, reject) => {
                if (node.config.verbose) node._debug('send_event_gw ' + endpointId);
                node.get_access_token('evn')
                    .then(access_token => {
                        let msg = {
                            event: {
                                header: {
                                    namespace: namespace,
                                    name: name,
                                    messageId: node.tokgen.generate(),
                                    payloadVersion: PAYLOADS_VERSION[namespace] || DEFAULT_PAYLOAD_VERSION
                                },
                                endpoint: {
                                    scope: {
                                        type: "BearerToken",
                                        token: access_token
                                    },
                                    endpointId: endpointId
                                },
                                payload: payload
                            },
                            context: {}
                        };
                        node.objectMerge(msg, other_data);
                        if (node.config.verbose) node._debug('send_event_gw msg ' + JSON.stringify(msg));
                        superagent
                            .post(node.config.event_endpoint)
                            .use(throttle.plugin())
                            .set('Authorization', 'Bearer ' + access_token)
                            .send(msg)
                            .end((err, res) => {
                                if (err) {
                                    node.error('send_event_gw ' + node.config.event_endpoint + ' err ' + JSON.stringify(err));
                                    reject(err);
                                } else {
                                    if (node.config.verbose) node._debug('send_event_gw res ' + JSON.stringify(res));
                                    resolve(res);
                                }
                            });
                        if (node.config.verbose) node._debug('send_event_gw sent');
                    })
                    .catch(err => {
                        node.error('send_event_gw get_access_token err ' + JSON.stringify(err));
                        reject(err);
                    });
            });
        }

        //
        //
        //
        //
        send_change_report(endpointId, changed_property_names, reason, cmd_res, namespace, name) {
            // https://github.com/alexa/alexa-smarthome/blob/master/sample_async/python/sample_async.py
            // https://developer.amazon.com/en-US/docs/alexa/smarthome/state-reporting-for-a-smart-home-skill.html
            // https://developer.amazon.com/en-US/docs/alexa/smarthome/send-events-to-the-alexa-event-gateway.html
            var node = this;
            return new Promise((resolve, reject) => {
                if (node.config.verbose) node._debug('send_change_report ' + endpointId);
                if (changed_property_names === undefined) {
                    changed_property_names = [];
                }
                else if (typeof changed_property_names === 'string') {
                    changed_property_names = [changed_property_names];
                }
                node.get_access_token('evn')
                    .then(access_token => {
                        let state = node.get_change_report(endpointId, namespace, name, undefined, changed_property_names, reason);
                        node.objectMerge(state, cmd_res);
                        if (node.config.verbose) node._debug('send_change_report state ' + JSON.stringify(state));
                        if (node.config.verbose) node._debug('send_change_report to event_endpoint ' + node.config.event_endpoint);
                        superagent
                            .post(node.config.event_endpoint)
                            .use(throttle.plugin())
                            .set('Authorization', 'Bearer ' + access_token)
                            .send(state)
                            .end((err, res) => {
                                if (err) {
                                    node.error('send_change_report err ' + JSON.stringify(err));
                                    reject(err);
                                } else {
                                    if (node.config.verbose) node._debug('send_change_report res ' + JSON.stringify(res));
                                    resolve(res);
                                }
                            });
                        if (node.config.verbose) node._debug('send_change_report sent');
                    })
                    .catch(err => {
                        node.error('send_change_report get_access_token err ' + JSON.stringify(err));
                    });
            });
        }

        //
        //
        //
        //
        send_delete_report(endpointIds, correlationToken) {
            // https://developer.amazon.com/en-US/docs/alexa/device-apis/alexa-discovery.html
            var node = this;
            if (node.config.verbose) node._debug('send_delete_report ' + JSON.stringify(endpointIds));
            node.get_access_token('evn')
                .then(access_token => {
                    const report = node.get_delete_report(endpointIds, correlationToken, access_token);
                    if (node.config.verbose) node._debug('send_delete_report report ' + JSON.stringify(report));
                    superagent
                        .post(node.config.event_endpoint)
                        .use(throttle.plugin())
                        .set('Authorization', 'Bearer ' + access_token)
                        .send(report)
                        .end((err, res) => {
                            if (err) {
                                node.error('send_delete_report err ' + JSON.stringify(err));
                            } else {
                                if (node.config.verbose) node._debug('send_delete_report res ' + JSON.stringify(res));
                            }
                        });
                    if (node.config.verbose) node._debug('send_delete_report sent');
                })
                .catch(err => {
                    node.error('send_delete_report get_access_token err ' + JSON.stringify(err));
                })
        }

        //
        //
        //
        //
        get_response_report(endpointId, correlationToken, access_token, namespace, name) {
            var node = this;
            const properties = node.devices[endpointId].getProperties();
            let response = {
                event: {
                    header: {
                        namespace: namespace || "Alexa",
                        name: name || "Response",
                        messageId: node.tokgen.generate(),
                        correlationToken: correlationToken,
                        payloadVersion: PAYLOADS_VERSION[namespace || "Alexa"] || DEFAULT_PAYLOAD_VERSION
                    },
                    endpoint: {
                        scope: {
                            type: "BearerToken",
                            token: access_token
                        },
                        endpointId: endpointId
                    },
                    payload: {}
                },
                context: {
                    properties: properties
                }
            };
            return response;
        }


        //
        //
        //
        //
        get_add_or_update_report(endpointId) {
            var node = this;
            const access_token = node.tokens.evn.access_token;
            const endpoint = node.devices[endpointId].getEndpoint();
            const state = {
                event: {
                    header: {
                        namespace: "Alexa.Discovery",
                        name: "AddOrUpdateReport",
                        messageId: node.tokgen.generate(),
                        payloadVersion: PAYLOADS_VERSION['Alexa.Discovery'] || DEFAULT_PAYLOAD_VERSION
                    },
                    payload: {
                        endpoints: [
                            endpoint
                        ],
                        scope: {
                            type: "BearerToken",
                            token: access_token
                        }
                    }
                },
            };
            return state;
        }

        //
        //
        //
        //
        send_add_or_update_report(endpointId) {
            // https://github.com/alexa/alexa-smarthome/blob/master/sample_async/python/sample_async.py
            // https://developer.amazon.com/en-US/docs/alexa/smarthome/state-reporting-for-a-smart-home-skill.html
            // https://developer.amazon.com/en-US/docs/alexa/smarthome/send-events-to-the-alexa-event-gateway.html
            // https://developer.amazon.com/en-US/docs/alexa/device-apis/alexa-discovery.html
            var node = this;
            if (node.config.verbose) node._debug('send_add_or_update_report ' + endpointId);
            node.get_access_token('evn')
                .then(access_token => {
                    const state = node.get_add_or_update_report(endpointId);
                    state.event.header.namespace = "Alexa.Discovery";
                    if (node.config.verbose) node._debug('send_add_or_update_report state ' + JSON.stringify(state));
                    if (node.config.verbose) node._debug('send_add_or_update_report to event_endpoint ' + node.config.event_endpoint);
                    superagent
                        .post(node.config.event_endpoint)
                        .use(throttle.plugin())
                        .set('Authorization', 'Bearer ' + access_token)
                        .send(state)
                        .end((err, res) => {
                            if (err) {
                                node.error('send_add_or_update_report err ' + JSON.stringify(err));
                            } else {
                                if (node.config.verbose) node._debug('send_add_or_update_report res ' + JSON.stringify(res));
                            }
                        });
                })
                .catch(err => {
                    node.error('send_add_or_update_report get_access_token err ' + JSON.stringify(err));
                });
            if (node.config.verbose) node._debug('send_add_or_update_report sent');
        }

        //
        //
        //
        // 
        send_media_created_or_updated(endpointId, media) {
            // https://github.com/alexa/alexa-smarthome/blob/master/sample_async/python/sample_async.py
            // https://developer.amazon.com/en-US/docs/alexa/device-apis/alexa-mediametadata.html
            // https://developer.amazon.com/en-US/docs/alexa/smarthome/state-reporting-for-a-smart-home-skill.html
            // https://developer.amazon.com/en-US/docs/alexa/smarthome/send-events-to-the-alexa-event-gateway.html
            var node = this;
            if (media) {
                if (Array.isArray(media)) {
                    media.forEach(m => node.send_media_created_or_updated(endpointId, m));
                } else {
                    if (node.config.verbose) node._debug('send_media_created_or_updated ' + endpointId);
                    node.get_access_token('evn')
                        .then(access_token => {
                            const msg = node.get_media_created_or_updated(endpointId, media);
                            if (node.config.verbose) node._debug('send_media_created_or_updated msg ' + JSON.stringify(msg));
                            if (node.config.verbose) node._debug('send_media_created_or_updated to event_endpoint ' + node.config.event_endpoint);
                            superagent
                                .post(node.config.event_endpoint)
                                .use(throttle.plugin())
                                .set('Authorization', 'Bearer ' + access_token)
                                .send(msg)
                                .end((err, res) => {
                                    if (err) {
                                        node.error('send_media_created_or_updated err ' + JSON.stringify(err));
                                    } else {
                                        if (node.config.verbose) node._debug('send_media_created_or_updated res ' + JSON.stringify(res));
                                    }
                                });
                            if (node.config.verbose) node._debug('send_media_created_or_updated sent');
                        })
                        .catch(err => {
                            node.error('send_media_created_or_updated get_access_token err ' + JSON.stringify(err));
                        });
                }
            }
        }

        //
        //
        //
        //
        send_media_deleted(endpointId, mediaIds) {
            // https://github.com/alexa/alexa-smarthome/blob/master/sample_async/python/sample_async.py
            // https://developer.amazon.com/en-US/docs/alexa/device-apis/alexa-mediametadata.html
            // https://developer.amazon.com/en-US/docs/alexa/smarthome/state-reporting-for-a-smart-home-skill.html
            // https://developer.amazon.com/en-US/docs/alexa/smarthome/send-events-to-the-alexa-event-gateway.html
            var node = this;
            if (node.config.verbose) node._debug('send_media_deleted ' + endpointId);
            if (mediaIds === undefined) {
                mediaIds = [];
            }
            else if (typeof mediaIds === 'string') {
                mediaIds = [mediaIds];
            }
            if (mediaIds) {
                node.get_access_token('evn')
                    .then(access_token => {
                        const msg = node.get_media_deleted(endpointId, mediaIds);
                        if (node.config.verbose) node._debug('send_media_deleted msg ' + JSON.stringify(msg));
                        if (node.config.verbose) node._debug('send_media_deleted to event_endpoint ' + node.config.event_endpoint);
                        superagent
                            .post(node.config.event_endpoint)
                            .use(throttle.plugin())
                            .set('Authorization', 'Bearer ' + access_token)
                            .send(msg)
                            .end((err, res) => {
                                if (err) {
                                    node.error('send_media_deleted err ' + JSON.stringify(err));
                                } else {
                                    if (node.config.verbose) node._debug('send_media_deleted res ' + JSON.stringify(res));
                                }
                            });
                        if (node.config.verbose) node._debug('send_media_deleted sent');
                    })
                    .catch(err => {
                        node.error('send_media_deleted get_access_token err ' + JSON.stringify(err));
                    });
            }
        }

        //
        //
        //
        //
        get_mapped_property(namespace, name) {
            Object.keys(PROPERTIES_MAPPING).forEach(i_name => {
                if (PROPERTIES_MAPPING[i_name][1] === name && PROPERTIES_MAPPING[i_name][0] === namespace) {
                    name = i_name;
                }
            });
            return name;
        }

        //
        //
        //
        //
        is_changed_property(name, namespace, changed_property_names) {
            if (changed_property_names.includes(name)) {
                return true;
            }
            let res = false;
            Object.keys(PROPERTIES_MAPPING).forEach(key => {
                if (PROPERTIES_MAPPING[key][1] === name && PROPERTIES_MAPPING[key][0] === namespace && changed_property_names.includes(key)) {
                    res = true;
                }
            });
            return res;
        }
        //
        //
        //
        //
        get_change_report(endpointId, namespace, name, messageId, changed_property_names, reason) {
            var node = this;
            let changed_properties = [];
            let unchanged_properties = [];
            let payload = {};
            const oauth2_bearer_token = node.tokens.evn.access_token;
            const properties = node.devices[endpointId].getProperties();
            if (node.config.verbose) node._debug('get_change_report endpointId ' + endpointId + ' properties ' + JSON.stringify(properties));
            if (changed_property_names.length > 0) {
                properties.forEach(property => {
                    if (node.is_changed_property(property.name, property.namespace, changed_property_names)) {
                        changed_properties.push(property);
                    } else {
                        unchanged_properties.push(property);
                    }
                });
                if (changed_properties.length > 0) {
                    payload = {
                        change: {
                            cause: {
                                type: reason || PHYSICAL_INTERACTION
                            },
                            properties: changed_properties
                        }
                    };
                }
            } else {
                unchanged_properties = properties;
            }
            const state = {
                event: {
                    header: {
                        namespace: namespace || "Alexa",
                        name: name || "ChangeReport",
                        messageId: messageId || node.tokgen.generate(),
                        payloadVersion: PAYLOADS_VERSION['Alexa'] || DEFAULT_PAYLOAD_VERSION
                    },
                    endpoint: {
                        scope: {
                            type: "BearerToken",
                            token: oauth2_bearer_token
                        },
                        endpointId: endpointId
                    },
                    payload: payload
                },
                context: {
                    properties: unchanged_properties
                }
            };
            return state;
        }

        //
        //
        //
        //
        get_media_created_or_updated(endpointId, media, namespace, name, messageId) {
            var node = this;
            const oauth2_bearer_token = node.tokens.evn.access_token;
            if (node.config.verbose) node._debug('endpointId ' + endpointId + ' mediaIds ' + JSON.stringify(mediaIds));
            const msg = {
                event: {
                    header: {
                        namespace: namespace || "Alexa.MediaMetadata",
                        name: name || "MediaCreatedOrUpdated",
                        messageId: messageId || node.tokgen.generate(),
                        payloadVersion: PAYLOADS_VERSION[namespace || "Alexa.MediaMetadata"] || DEFAULT_PAYLOAD_VERSION
                    },
                    endpoint: {
                        scope: {
                            type: "BearerToken",
                            token: oauth2_bearer_token
                        },
                        endpointId: endpointId,
                    },
                    payload: {
                        scope: {
                            type: "BearerToken",
                            token: oauth2_bearer_token
                        },
                        media: media
                    }
                }
            };
            return msg;
        }

        //
        //
        //
        //
        get_media_deleted(endpointId, mediaIds, namespace, name, messageId) {
            var node = this;
            const oauth2_bearer_token = node.tokens.evn.access_token;
            if (node.config.verbose) node._debug('endpointId ' + endpointId + ' mediaIds ' + JSON.stringify(mediaIds));
            const msg = {
                event: {
                    header: {
                        namespace: namespace || "Alexa.MediaMetadata",
                        name: name || "MediaDeleted",
                        messageId: messageId || node.tokgen.generate(),
                        payloadVersion: PAYLOADS_VERSION['Alexa.MediaMetadata'] || DEFAULT_PAYLOAD_VERSION
                    },
                    endpoint: {
                        scope: {
                            type: "BearerToken",
                            token: oauth2_bearer_token
                        },
                        endpointId: endpointId,
                    },
                    payload: {
                        scope: {
                            type: "BearerToken",
                            token: oauth2_bearer_token
                        },
                        mediaIds: mediaIds
                    }
                }
            };
            return msg;
        }

        //
        //
        //
        //
        /*get_state(endpointId) {
            var node = this;
            const messageId = node.tokgen.generate();
            if (endpointId) {
                if (node.devices[endpointId]) {
                    const state = {
                        event: {
                            header: {
                                namespace: "Alexa",
                                name: "StateReport",
                                messageId: messageId,
                                payloadVersion: PAYLOADS_VERSION['Alexa'] || DEFAULT_PAYLOAD_VERSION,
                            },
                            endpoint: {
                                endpoints: endpointId,
                                scope: {
                                    type: "BearerToken",
                                    token: node.tokens.evn.access_token
                                },
                            },
                            payload: {},
                        },
                        context: {
                            properties: node.devices[endpointId].getProperties()
                        }
                    };
                    if (node.config.verbose) node._debug("CCHI state " + JSON.stringify(state));
                }
            } else {
                // TODO all states??
            }
        }*/

        //
        //
        //
        //
        get_tokens() {
            var node = this;
            return new Promise((resolve, reject) => {
                if (node.tokens === undefined) {
                    node.loadJson("tokens", node.tokens_filename, {}, node.user_dir)
                        .then(json => {
                            node.tokens = json;
                            resolve(node.tokens);
                        })
                        .catch(err => {
                            reject(err);
                        });
                } else {
                    resolve(node.tokens);
                }
            });
        }

        //
        //
        //
        //
        save_tokens() {
            var node = this;
            return new Promise((resolve, reject) => {
                if (node.tokens) {
                    node.writeJson("tokens", node.tokens_filename, node.tokens, node.user_dir)
                        .then(() => {
                            resolve(node.tokens);
                        })
                        .catch(err => {
                            reject(err);
                        });
                } else {
                    reject('No tokens');
                }
            });
        }

        //
        //
        //
        //
        // https://developer.amazon.com/docs/login-with-amazon/authorization-code-grant.html
        get_access_token(type, code) {
            var node = this;
            if (node.config.verbose) node._debug("get_access_token " + type);
            return new Promise((resolve, reject) => {
                node.get_tokens()
                    .then(tokens => {
                        let params = false;
                        if (code) {
                            if (node.config.verbose) node._debug("get_access_token request with code");
                            // access token not retrieved yet for the first time, so this should be an access token request
                            params = {
                                grant_type: "authorization_code",
                                code: code,
                                redirect_uri: node.skill_link_req.oauth_uri
                            }
                        } else if (node.tokens[type]) {
                            if (node.tokens[type].access_token) {
                                if (node.tokens[type].expire_at > Date.now()) {
                                    if (node.config.verbose) node._debug("get_access_token use access_token " + type);
                                    return resolve(node.tokens[type].access_token);
                                }
                            }
                            if (node.tokens[type].refresh_token) {
                                // access token already retrieved the first time, so this should be a token refresh request
                                if (node.config.verbose) node._debug("get_access_token request with refresh_token " + type);
                                params = {
                                    grant_type: "refresh_token",
                                    refresh_token: node.tokens[type].refresh_token,
                                    // redirect_uri: node.skill_link_req.oauth_uri
                                }
                            }
                        }
                        if (params) {
                            if (node.config.verbose) node._debug("get_access_token request " + JSON.stringify(params));
                            let client_id = type === 'evn' ? node.credentials.skill_client_id : node.credentials.oa2_client_id;
                            let secret = type === 'evn' ? node.credentials.skill_secret : node.credentials.oa2_secret;
                            superagent
                                .post(LWA_TOKEN_URI)
                                .type('form')
                                .send(params)
                                .set('Authorization', 'Basic ' + Buffer.from(client_id + ":" + secret).toString("base64"))
                                // .set('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8')
                                .then(res => {
                                    if (node.config.verbose) node._debug("CCHI get_access_token res " + JSON.stringify(res));
                                    if (res.status === 200) {
                                        node.tokens[type] = {
                                            access_token: res.body.access_token,
                                            refresh_token: res.body.refresh_token,
                                            expire_at: Date.now() + res.body.expires_in * 1000
                                        };
                                        return node.save_tokens()
                                            .then(() => {
                                                if (node.config.verbose) node._debug("get_access_token tokens " + type + " saved");
                                                return resolve(node.tokens[type].access_token);
                                            })
                                            .catch(err => {
                                                node.error("get_access_token save tokens " + type + " error " + err);
                                                return reject(err);
                                            });
                                    }
                                    node.error("get_access_token: Unable to  get token " + type + ", status=" + res.status);
                                    return reject(res.status);
                                })
                                .catch(err => {
                                    node.error("get_access_token: Unable to get token " + type + ", err=" + JSON.stringify(err));
                                    return reject(err);
                                });
                        } else {
                            node.error("get_access_token " + type + ": No codes");
                            return reject('No codes');
                        }
                    })
                    .catch(err => {
                        return reject(err);
                    });
            });
        }

        //
        //
        //
        //
        loadJsonSync(text, filename, defaultValue, userDir) {
            var node = this;
            if (node.config.verbose) node._debug('loadJsonSync: ' + text);
            let full_filename;
            if (!filename.startsWith(path.sep)) {
                full_filename = path.join(userDir, filename);
            } else {
                full_filename = filename;
            }
            if (node.config.verbose) node._debug('loadJsonSync: filename ' + full_filename);

            try {
                if (fs.existsSync(full_filename)) {
                    let jsonFile = fs.readFileSync(
                        full_filename,
                        {
                            'encoding': 'utf8',
                            'flag': fs.constants.R_OK | fs.constants.W_OK | fs.constants.O_CREAT
                        });

                    if (jsonFile === '') {
                        if (node.config.verbose) node._debug('loadJsonSync: file ' + filename + ' is empty');
                        return defaultValue;
                    } else {
                        if (node.config.verbose) node._debug('loadJsonSync: data loaded');
                        const json = JSON.parse(jsonFile);
                        if (node.config.verbose) node._debug('loadJsonSync: json = ' + JSON.stringify(json));
                        return json;
                    }
                } else {
                    if (node.config.verbose) node._debug('loadJsonSync: file ' + filename + ' not found');
                    return defaultValue;
                }
            }
            catch (err) {
                node.error('loadJsonSync: Error on loading ' + text + ' filename ' + filename + ': ' + err.toString());
                return defaultValue;
            }
        }

        //
        //
        //
        //
        writeJsonSync(text, filename, value, userDir) {
            var node = this;
            if (node.config.verbose) node._debug('writeJsonSync: ' + text);
            if (!filename.startsWith(path.sep)) {
                filename = path.join(userDir, filename);
            }
            if (node.config.verbose) node._debug('writeJsonSync: filename ' + filename);
            if (typeof value === 'object') {
                value = JSON.stringify(value);
            }
            try {
                fs.writeFileSync(
                    filename,
                    value,
                    {
                        'encoding': 'utf8',
                        'flag': fs.constants.W_OK | fs.constants.O_CREAT | fs.constants.O_TRUNC
                    });

                if (node.config.verbose) node._debug('writeJsonSync: ' + text + ' saved');
                return true;
            }
            catch (err) {
                node.error('writeJsonSync: Error on saving ' + text + ' filename + ' + filename + ': ' + err.toString());
                return false;
            }
        }


        //
        //
        //
        //
        loadJson(tag, filename, defaultValue, userDir) {
            var node = this;
            if (node.config.verbose) node._debug('loadJson: ' + tag);
            let full_filename;
            if (!filename.startsWith(path.sep)) {
                full_filename = path.join(userDir, filename);
            } else {
                full_filename = filename;
            }
            if (node.config.verbose) node._debug('loadJson: filename ' + full_filename);

            return new Promise((resolve, reject) => {
                fs.readFile(full_filename,
                    {
                        'encoding': 'utf8',
                        'flag': fs.constants.R_OK | fs.constants.W_OK | fs.constants.O_CREAT
                    },
                    function (err, data) {
                        if (err) {
                            node.error('loadJson: Error on loading ' + tag + ' filename ' + filename + ': ' + err.toString());
                            return resolve(defaultValue);
                        }
                        if (data.trim() === '') {
                            if (node.config.verbose) node._debug('loadJson: file ' + filename + ' is empty');
                            return resolve(defaultValue);
                        }
                        if (node.config.verbose) node._debug('loadJson: data loaded');
                        try {
                            const json = JSON.parse(data);
                            if (node.config.verbose) node._debug('loadJson: json = ' + JSON.stringify(json));
                            return resolve(json);
                        } catch (err) {
                            node.error("loadJson " + tag + ' error ' + err.stack);
                        }
                    });
            });
        }

        //
        //
        //
        //
        writeJson(tag, filename, data, userDir) {
            var node = this;
            if (node.config.verbose) node._debug('writeJson: ' + tag);
            if (!filename.startsWith(path.sep)) {
                filename = path.join(userDir, filename);
            }
            if (node.config.verbose) node._debug('writeJson: filename ' + filename);
            if (typeof data === 'object') {
                data = JSON.stringify(data);
            }
            return new Promise((resolve, reject) => {
                fs.writeFile(
                    filename,
                    data,
                    {
                        'encoding': 'utf8',
                        'flag': fs.constants.W_OK | fs.constants.O_CREAT | fs.constants.O_TRUNC
                    }, function (err) {
                        if (err) {
                            node.error('writeJson: Error on saving the filename + ' + filename + ': ' + err.toString());
                            return reject(err);
                        }
                        if (node.config.verbose) node._debug('writeJson: ' + tag + ' saved');
                        return resolve(data);
                    });
            });
        }

        //
        //
        //
        //
        objectMerge(to_object, from_object) {
            var node = this;
            if (from_object) {
                Object.keys(from_object).forEach(function (key) {
                    if (to_object.hasOwnProperty(key)) {
                        if (typeof from_object[key] === 'object') {
                            node.objectMerge(to_object[key], from_object[key]);
                        } else {
                            to_object[key] = from_object[key];
                        }
                    } else {
                        to_object[key] = from_object[key];
                    }
                });
            }
        }

        //
        //
        //
        Path_join() {
            let full_path = '';
            for (var i = 0; i < arguments.length; i++) {
                let ipath = arguments[i];
                let fpe = full_path.endsWith('/');
                let ips = ipath.startsWith('/');
                if (fpe && ips) {
                    full_path += ipath.substring(1);
                } else if (!fpe && !ips) {
                    full_path += '/' + ipath;
                } else {
                    full_path += ipath;
                }
            }
            return full_path;
        }

    }

    //
    //
    //
    //
    RED.nodes.registerType("alexa-adapter", AlexaAdapterNode, {
        credentials: {
            username: { type: "text" },
            password: { type: "password" },
            your_client_id: { type: "text" },
            your_secret: { type: "password" },
            oa2_client_id: { type: "text" },
            oa2_secret: { type: "password" },
            skill_client_id: { type: "text" },
            skill_secret: { type: "password" },
        }
    });
}
